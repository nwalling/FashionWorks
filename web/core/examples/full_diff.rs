//! Build a whole manifest with the port and diff it against the Python's.
//!
//! The per-field harness scores each rule in isolation against known-good
//! inputs. This runs the real thing end to end -- every item assembled, sets
//! assigned, variants linked -- which is what WEB.md's 99.5% bar is written
//! against, and the only way `set` and `variant_of` get tested through the
//! chain that feeds them rather than from the manifest's own answers.

use std::collections::HashMap;
use std::time::Instant;

use fashionworks_core::catalog::{build, db, tint, Localization};
use serde_json::Value;

fn main() {
    let mut args = std::env::args().skip(1);
    let dcb_path = args.next().expect("usage: full_diff <Game2.dcb> <manifest.json> <global.ini>");
    let manifest_path = args.next().expect("manifest.json");
    let ini_path = args.next().expect("global.ini");

    let bytes = std::fs::read(&dcb_path).expect("reading Game2.dcb");
    let database = db::open(&bytes).expect("parsing DataCore");
    let raw = std::fs::read(&ini_path).expect("reading global.ini");
    let loc = Localization::parse(&String::from_utf8_lossy(&raw));
    let palettes = tint::PaletteIndex::build(&database);
    let makers = db::index_by_name(&database, "SCItemManufacturer");
    println!("locale {} keys, {} palettes, {} manufacturers", loc.len(), palettes.len(), makers.len());

    let t = Instant::now();
    let records = db::armor_records(&database);
    let mut items: Vec<Value> = records
        .iter()
        .filter_map(|r| build::build_item(&r.value, &palettes, &makers, &loc, "male", &r.source_path))
        .filter(|i| {
            !i["flags"].as_array().map(|f| f.iter().any(|x| x == "npc")).unwrap_or(false)
        })
        .collect();
    items.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                v["slot"].as_str().unwrap_or("").to_string(),
                v["name"].as_str().unwrap_or("").to_ascii_lowercase(),
                v["class_name"].as_str().unwrap_or("").to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    build::assign_sets(&mut items);
    build::link_variants(&mut items);
    println!("built  {} items in {:?}\n", items.len(), t.elapsed());

    let manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).expect("manifest")).expect("json");
    let want: HashMap<&str, &Value> = manifest["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|i| Some((i["id"].as_str()?, i)))
        .collect();

    // Every field the port produces. `swatch` and `assets` are deliberately
    // absent: they are filled in later by the convert and variants stages, not
    // by the catalogue.
    const FIELDS: [&str; 24] = [
        "class_name", "name", "name_key", "description", "description_key", "slot",
        "sub_slot", "weight_class", "manufacturer", "set", "variant_of", "variants",
        "tint", "tags", "geometry", "materials", "bind_mode", "socket", "flags", "stats",
        "ports", "outfit", "chunks", "hidden",
    ];
    let mut agree: HashMap<&str, (usize, usize, Vec<String>)> = HashMap::new();
    let mut unmatched = 0;

    for got in &items {
        let Some(exp) = got["id"].as_str().and_then(|id| want.get(id)) else {
            unmatched += 1;
            continue;
        };
        for field in FIELDS {
            let a = got.get(field).unwrap_or(&Value::Null);
            let b = exp.get(field).unwrap_or(&Value::Null);
            let same = if field == "variants" {
                let norm = |v: &Value| {
                    let mut s: Vec<String> = v.as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default();
                    s.sort();
                    s
                };
                norm(a) == norm(b)
            } else {
                a == b
            };
            let e = agree.entry(field).or_insert((0, 0, Vec::new()));
            e.0 += 1;
            if same {
                e.1 += 1;
            } else if e.2.len() < 3 {
                e.2.push(format!(
                    "{}: {} vs {}",
                    got["class_name"].as_str().unwrap_or(""),
                    truncate(a), truncate(b)
                ));
            }
        }
    }

    println!("items built {}, matched by id {}, unmatched {unmatched}", items.len(), items.len() - unmatched);

    // And the other direction, which this harness did not report for a long
    // time and which is the one that matters more: a manifest item the port
    // never builds is invisible to a port-to-manifest comparison, so "100% on
    // 2426 items, none unmatched" was true while 189 of the manifest's 2615
    // were simply absent. A rate is only a rate over a denominator, and the
    // denominator has to be the reference, not the port's own output.
    let built: std::collections::HashSet<&str> =
        items.iter().filter_map(|i| i["id"].as_str()).collect();
    let missing: Vec<&&Value> = want
        .iter()
        .filter(|(id, _)| !built.contains(*id))
        .map(|(_, v)| v)
        .collect();
    println!(
        "manifest items {}, built by the port {}, missing {} ({:.1}%)",
        want.len(),
        want.len() - missing.len(),
        missing.len(),
        missing.len() as f64 / want.len().max(1) as f64 * 100.0
    );
    if !missing.is_empty() {
        let mut by_slot: std::collections::BTreeMap<&str, usize> = Default::default();
        let mut by_flag: std::collections::BTreeMap<String, usize> = Default::default();
        for item in &missing {
            *by_slot.entry(item["slot"].as_str().unwrap_or("?")).or_default() += 1;
            let flags = item["flags"]
                .as_array()
                .map(|f| {
                    f.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            *by_flag.entry(if flags.is_empty() { "(none)".into() } else { flags }).or_default() += 1;
        }
        if std::env::var("SHOW_MISSING").is_ok() {
            for item in &missing {
                println!("MISSING {}", item["class_name"].as_str().unwrap_or("?"));
            }
        }
        println!("    by slot:  {by_slot:?}");
        println!("    by flags: {by_flag:?}");
        // The flagged ones explain themselves: an item with no geometry has
        // nothing to render and a placeholder is hidden. The unflagged ones do
        // not, so they are listed in full.
        let unflagged: Vec<&&&Value> = missing
            .iter()
            .filter(|i| i["flags"].as_array().map(|f| f.is_empty()).unwrap_or(true))
            .collect();
        println!("\n    {} missing with no flags at all:", unflagged.len());
        for item in &unflagged {
            println!(
                "      {:<44} {:<34} {} geom={} mat={}",
                item["class_name"].as_str().unwrap_or("?"),
                item["name"].as_str().unwrap_or("?"),
                item["slot"].as_str().unwrap_or("?"),
                item["geometry"].as_array().map(|g| g.len()).unwrap_or(0),
                item["materials"].as_array().map(|m| m.len()).unwrap_or(0),
            );
        }
    }
    println!("\n{:<16} {:>7} {:>7}  rate", "field", "agree", "of");
    let mut names: Vec<&&str> = agree.keys().collect();
    names.sort();
    let mut total = 0usize;
    let mut ok = 0usize;
    for name in names {
        let (n, a, ex) = &agree[*name];
        total += n; ok += a;
        let rate = *a as f64 / (*n).max(1) as f64 * 100.0;
        println!("{name:<16} {a:>7} {n:>7}  {rate:>6.2}%{}", if rate >= 99.5 { "  PASS" } else { "" });
        for e in ex { println!("                  {e}"); }
    }
    println!("\nOVERALL {:.3}%  (bar: 99.5%)", ok as f64 / total.max(1) as f64 * 100.0);

    // Gear, both ways, every field. LOADOUT.md Phase 1.
    let gear = fashionworks_core::build_gear(&database, &palettes, &makers, &loc);
    let want_gear: HashMap<&str, &Value> = manifest["gear"]
        .as_array()
        .map(|a| a.iter().filter_map(|i| Some((i["id"].as_str()?, i))).collect())
        .unwrap_or_default();
    const GEAR_FIELDS: [&str; 18] = [
        "class_name", "name", "name_key", "description", "description_key", "slot",
        "manufacturer", "attach", "anim_set", "variant_of", "variants", "tint", "geometry",
        "materials", "default_children", "ports", "flags", "tags",
    ];
    let mut gear_total = 0usize;
    let mut gear_ok = 0usize;
    let mut gear_bad: HashMap<&str, Vec<String>> = HashMap::new();
    let mut gear_unmatched = 0usize;
    for got in &gear {
        let Some(exp) = got["id"].as_str().and_then(|id| want_gear.get(id)) else {
            gear_unmatched += 1;
            continue;
        };
        for field in GEAR_FIELDS {
            let a = got.get(field).unwrap_or(&Value::Null);
            let b = exp.get(field).unwrap_or(&Value::Null);
            let same = if field == "variants" {
                let norm = |v: &Value| {
                    let mut s: Vec<String> = v.as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default();
                    s.sort();
                    s
                };
                norm(a) == norm(b)
            } else {
                close(a, b)
            };
            gear_total += 1;
            if same {
                gear_ok += 1;
            } else {
                let list = gear_bad.entry(field).or_default();
                if list.len() < 3 {
                    let show = |v: &Value| if std::env::var("FULL").is_ok() { v.to_string() } else { truncate(v) };
                    list.push(format!("{}: {} vs {}", got["class_name"].as_str().unwrap_or(""), show(a), show(b)));
                }
            }
        }
    }
    let gear_built: std::collections::HashSet<&str> = gear.iter().filter_map(|g| g["id"].as_str()).collect();
    let gear_missing = want_gear.keys().filter(|id| !gear_built.contains(*id)).count();
    println!(
        "\nGEAR built {}, manifest {}, unmatched {gear_unmatched}, missing {gear_missing}, fields {:.3}%",
        gear.len(), want_gear.len(), gear_ok as f64 / gear_total.max(1) as f64 * 100.0,
    );
    for (field, examples) in &gear_bad {
        println!("  {field}");
        for e in examples { println!("      {e}"); }
    }
}

/// JSON equality with numbers compared to a relative 1e-12, so a float that
/// Python and Rust round differently in its last digit -- a palette
/// glossiness of 230/255 came out ...255 on one side and ...256 on the other --
/// is not reported as a disagreement about the data.
fn close(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap_or(f64::NAN), y.as_f64().unwrap_or(f64::NAN));
            x == y || (x - y).abs() <= 1e-12 * x.abs().max(y.abs())
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| close(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| close(v, w)))
        }
        _ => a == b,
    }
}

fn truncate(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 60 { format!("{}…", &s[..60]) } else { s }
}
