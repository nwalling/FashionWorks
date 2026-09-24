//! Light from the archive: the game's lighting probes and its authored rigs.
//!
//! RENDERING.md Phase 1. Two things the viewer used to invent and now reads:
//!
//! **Probes.** `Data/Textures/cubemaps/inventory_setup/cm_inventory_probe_cm.dds`
//! is the lighting the game shows items in, and the look-development probes
//! under `Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/` are its
//! studio, hangar and planet references. Every one is a 256² BC6H UF16 cube.
//! StarBreaker's `decode_rgba` takes BC6H to 8 bits through its own Reinhard
//! curve, which discards exactly the range image-based lighting needs, so the
//! faces are decoded here to linear float instead.
//!
//! **Rigs.** A light group in an object container is a set of baked-in lights,
//! each a `Light` node carrying a `RelativeXForm` and an `EntityComponentLight`
//! whose `defaultState` holds the authored intensity and colour. The character
//! customizer's `LightRig_Female_Lightgroup` is ten spots. StarBreaker reads
//! these too, but behind its `pipeline` feature, which the browser build does
//! not carry, so this is a reduced reader over the same public crates.

use starbreaker_chunks::ChunkFile;
use starbreaker_dds::DdsFile;
use starbreaker_p4k::P4kArchive;

/// An HDR cube as linear float RGBA: six faces of `size`², in DDS face order
/// (+X, -X, +Y, -Y, +Z, -Z), alpha 1.
pub struct HdrCube {
    pub size: u32,
    pub rgba: Vec<f32>,
}

/// The largest mip no wider than `max_size`, decoded to float.
pub fn hdr_cube(dds: &DdsFile, max_size: u32) -> Result<HdrCube, String> {
    if !dds.is_cubemap() {
        return Err("not a cubemap".into());
    }
    let mut mip = 0;
    while mip + 1 < dds.mip_count() && dds.dimensions(mip).0 > max_size {
        mip += 1;
    }
    let (w, h) = dds.dimensions(mip);
    let data = dds
        .mip_data
        .get(mip)
        .ok_or_else(|| format!("mip {mip} missing"))?;
    // BC6H is sixteen bytes per 4x4 block; a cube mip holds all six faces.
    let face = w.div_ceil(4) as usize * h.div_ceil(4) as usize * 16;
    if data.len() < face * 6 {
        return Err(format!("mip {mip} holds {} bytes; six faces need {}", data.len(), face * 6));
    }
    let mut rgba = Vec::with_capacity((w * h) as usize * 4 * 6);
    for f in 0..6 {
        let rgb = starbreaker_dds::decode::decode_bc6h_to_float_rgb(&data[f * face..(f + 1) * face], w, h)
            .map_err(|e| format!("decoding face {f}: {e}"))?;
        for texel in rgb.chunks_exact(3) {
            rgba.extend_from_slice(&[texel[0].max(0.0), texel[1].max(0.0), texel[2].max(0.0), 1.0]);
        }
    }
    Ok(HdrCube { size: w, rgba })
}

/// One light of an authored rig, in the archive's own Z-up frame.
#[derive(Debug, Clone)]
pub struct RigLight {
    pub name: String,
    /// `Projector` (a spot) or `Omni`.
    pub kind: String,
    pub position: [f32; 3],
    /// Where the light points: the entity's +X, as CryEngine lights do.
    pub direction: [f32; 3],
    /// Linear 0-1, from the colour temperature when the light uses one.
    pub color: [f32; 3],
    /// The authored `defaultState` intensity, unscaled. What it means in
    /// physical units is the renderer's calibration, not the data's.
    pub intensity: f32,
    pub radius: f32,
    /// Full cone angle in degrees, for a projector.
    pub fov: f32,
    /// The gobo, if any.
    pub texture: Option<String>,
}

impl RigLight {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "kind": self.kind,
            "position": self.position,
            "direction": self.direction,
            "color": self.color,
            "intensity": self.intensity,
            "radius": self.radius,
            "fov": self.fov,
            "texture": self.texture,
        })
    }
}

/// Every light in the named group of an object container.
///
/// `group` matches the group entity's `Name` as a substring, which is how the
/// customizer's groups read: `LightRig_Female_Lightgroup`, `Review_Male_...`.
pub fn light_rig(socpak: &[u8], group: &str) -> Result<Vec<RigLight>, String> {
    let archive = P4kArchive::from_bytes(socpak).map_err(|e| format!("reading container: {e}"))?;
    let mut lights = Vec::new();
    for entry in archive.entries() {
        if !entry.name.to_ascii_lowercase().ends_with(".soc") {
            continue;
        }
        let data = archive.read(entry).map_err(|e| format!("reading {}: {e}", entry.name))?;
        let Ok(ChunkFile::CrCh(crch)) = ChunkFile::from_bytes(&data) else { continue };
        for chunk in crch.chunks() {
            if chunk.chunk_type != starbreaker_chunks::known_types::crch::CRYXMLB {
                continue;
            }
            let Ok(xml) = starbreaker_cryxml::from_bytes(crch.chunk_data(chunk)) else { continue };
            collect_group(&xml, group, &mut lights);
        }
    }
    Ok(lights)
}

type Xml<'a> = starbreaker_cryxml::CryXml<'a>;
type Node = starbreaker_cryxml::CryXmlNode;

fn attr<'a>(xml: &Xml<'a>, node: &Node, key: &str) -> Option<&'a str> {
    xml.node_attributes(node).find(|(k, _)| *k == key).map(|(_, v)| v)
}

fn child<'a>(xml: &'a Xml<'a>, node: &Node, tag: &str) -> Option<&'a Node> {
    xml.node_children(node).find(|c| xml.node_tag(c) == tag)
}

fn floats(s: Option<&str>, fallback: &[f64]) -> Vec<f64> {
    let parsed: Vec<f64> = s
        .unwrap_or("")
        .split(',')
        .filter_map(|v| v.trim().parse::<f64>().ok())
        .collect();
    if parsed.len() == fallback.len() { parsed } else { fallback.to_vec() }
}

fn collect_group(xml: &Xml<'_>, group: &str, out: &mut Vec<RigLight>) {
    let root = xml.root();
    let entities: Vec<&Node> = if matches!(xml.node_tag(root), "Entities" | "SCOC_Entities") {
        vec![root]
    } else {
        xml.node_children(root)
            .filter(|c| matches!(xml.node_tag(c), "Entities" | "SCOC_Entities"))
            .collect()
    };
    for container in entities {
        for entity in xml.node_children(container) {
            if xml.node_tag(entity) != "Entity" {
                continue;
            }
            let name = attr(xml, entity, "Name").unwrap_or("");
            if !name.contains(group) {
                continue;
            }
            let pos = floats(attr(xml, entity, "Pos"), &[0.0, 0.0, 0.0]);
            let rot = floats(attr(xml, entity, "Rotate"), &[1.0, 0.0, 0.0, 0.0]);
            let scale = floats(attr(xml, entity, "Scale"), &[1.0, 1.0, 1.0]);
            // A group entity carries the component twice: once under
            // `PropertiesDataCore` with only its fade presets, and once as a
            // direct child holding the lights. Taking the first found none.
            let baked: Vec<&Node> = light_groups(xml, entity)
                .into_iter()
                .filter_map(|lg| child(xml, lg, "BakedInLights"))
                .collect();
            let lights = baked.into_iter().flat_map(|b| xml.node_children(b)).filter(|n| xml.node_tag(n) == "Light");
            for (index, light) in lights.enumerate() {
                let (t, r, s) = match child(xml, light, "RelativeXForm") {
                    Some(x) => (
                        floats(attr(xml, x, "translation"), &[0.0, 0.0, 0.0]),
                        floats(attr(xml, x, "rotation"), &[1.0, 0.0, 0.0, 0.0]),
                        floats(attr(xml, x, "scale"), &[1.0, 1.0, 1.0]),
                    ),
                    None => (vec![0.0; 3], vec![1.0, 0.0, 0.0, 0.0], vec![1.0; 3]),
                };
                let local = [t[0] * scale[0] * s[0], t[1] * scale[1] * s[1], t[2] * scale[2] * s[2]];
                let offset = rotate(&rot, local);
                let position = [pos[0] + offset[0], pos[1] + offset[1], pos[2] + offset[2]];
                let orientation = multiply(&rot, &r);
                let direction = rotate(&orientation, [1.0, 0.0, 0.0]);
                let Some(component) = child(xml, light, "EntityComponentLight") else { continue };
                if let Some(parsed) = component_light(xml, component, &format!("{name}-{index:03}"), position, direction) {
                    out.push(parsed);
                }
            }
        }
    }
}

fn light_groups<'a>(xml: &'a Xml<'a>, entity: &Node) -> Vec<&'a Node> {
    let mut out = Vec::new();
    for c in xml.node_children(entity) {
        match xml.node_tag(c) {
            "EntityComponentLightGroup" => out.push(c),
            "PropertiesDataCore" => out.extend(
                xml.node_children(c).filter(|g| xml.node_tag(g) == "EntityComponentLightGroup"),
            ),
            _ => {}
        }
    }
    out
}

fn component_light(
    xml: &Xml<'_>,
    component: &Node,
    name: &str,
    position: [f64; 3],
    direction: [f64; 3],
) -> Option<RigLight> {
    let kind = attr(xml, component, "lightType").unwrap_or("Omni").to_string();
    let use_temperature = matches!(attr(xml, component, "useTemperature"), Some("1" | "true" | "True"));
    // The first state with any light in it. A rig the customizer switches on
    // by sequence -- `LightRig_Female_On` -- is authored off in `defaultState`
    // and lit in another, so reading `defaultState` alone found only the one
    // always-on group of the customizer's seven.
    let lit = |tag: &str| {
        let state = child(xml, component, tag)?;
        let intensity = attr(xml, state, "intensity").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
        (intensity > 0.0).then_some((state, intensity))
    };
    let (state, intensity) = ["defaultState", "auxiliaryState", "emergencyState", "cinematicState"]
        .iter()
        .find_map(|tag| lit(tag))?;
    let color = if use_temperature {
        let kelvin = attr(xml, state, "temperature").and_then(|v| v.parse::<f32>().ok()).unwrap_or(6500.0);
        kelvin_to_rgb(kelvin)
    } else {
        child(xml, state, "color")
            .map(|c| {
                let f = |k| attr(xml, c, k).and_then(|v| v.parse::<f32>().ok()).unwrap_or(1.0).clamp(0.0, 1.0);
                [f("r"), f("g"), f("b")]
            })
            .unwrap_or([1.0, 1.0, 1.0])
    };
    let radius = child(xml, component, "sizeParams")
        .and_then(|s| attr(xml, s, "lightRadius"))
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|r| *r > 0.0)
        .unwrap_or(5.0);
    let (fov, texture) = child(xml, component, "projectorParams")
        .map(|p| {
            let fov = attr(xml, p, "FOV").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
            let texture = attr(xml, p, "texture").filter(|t| !t.is_empty()).map(str::to_string);
            (fov, texture)
        })
        .unwrap_or((0.0, None));
    Some(RigLight {
        name: name.to_string(),
        kind,
        position: [position[0] as f32, position[1] as f32, position[2] as f32],
        direction: [direction[0] as f32, direction[1] as f32, direction[2] as f32],
        color,
        intensity,
        radius,
        fov,
        texture,
    })
}

/// Quaternions as the archive stores them, `[w, x, y, z]`.
fn multiply(a: &[f64], b: &[f64]) -> [f64; 4] {
    let (aw, ax, ay, az) = (a[0], a[1], a[2], a[3]);
    let (bw, bx, by, bz) = (b[0], b[1], b[2], b[3]);
    [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]
}

fn rotate(q: &[f64], v: [f64; 3]) -> [f64; 3] {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
    // v + 2w(u x v) + 2 u x (u x v), with u the vector part.
    let (ux, uy, uz) = (x, y, z);
    let cx = uy * v[2] - uz * v[1];
    let cy = uz * v[0] - ux * v[2];
    let cz = ux * v[1] - uy * v[0];
    let ccx = uy * cz - uz * cy;
    let ccy = uz * cx - ux * cz;
    let ccz = ux * cy - uy * cx;
    [
        v[0] + 2.0 * (w * cx + ccx),
        v[1] + 2.0 * (w * cy + ccy),
        v[2] + 2.0 * (w * cz + ccz),
    ]
}

/// Black-body colour, the usual fit (Tanner Helland), linearised.
fn kelvin_to_rgb(kelvin: f32) -> [f32; 3] {
    let t = kelvin.clamp(1000.0, 40000.0) / 100.0;
    let r = if t <= 66.0 { 255.0 } else { 329.698_73 * (t - 60.0).powf(-0.133_204_76) };
    let g = if t <= 66.0 {
        99.470_8 * t.ln() - 161.119_57
    } else {
        288.122_16 * (t - 60.0).powf(-0.075_514_85)
    };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_73 * (t - 10.0).ln() - 305.044_8
    };
    let lin = |c: f32| {
        let c = (c / 255.0).clamp(0.0, 1.0);
        if c <= 0.040_45 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    [lin(r), lin(g), lin(b)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_light_points_along_its_rotated_x() {
        // 90 degrees about Z takes +X to +Y.
        let half = std::f64::consts::FRAC_PI_4;
        let q = [half.cos(), 0.0, 0.0, half.sin()];
        let d = rotate(&q, [1.0, 0.0, 0.0]);
        assert!((d[0]).abs() < 1e-9 && (d[1] - 1.0).abs() < 1e-9, "{d:?}");
    }

    #[test]
    fn daylight_is_near_white_and_candlelight_is_warm() {
        let day = kelvin_to_rgb(6500.0);
        assert!(day.iter().all(|c| *c > 0.85), "{day:?}");
        let warm = kelvin_to_rgb(2000.0);
        assert!(warm[0] > warm[2] * 3.0, "{warm:?}");
    }
}
