//! Which pieces turn on each conditional chunk (`catalog::visibility`).
//!
//! Builds the catalogue as the browser does and, for every piece with a chunk
//! drawn under conditions, lists the families whose pieces in the checked port
//! pass -- the Artimex helmet's cowl should answer to the Artimex cores and to
//! nothing else. Ends with what `tagged` costs the catalogue.
//!
//!   cargo run --example visibility_probe --release -- <Game2.dcb> <global.ini> [class prefix]

use std::collections::BTreeSet;

use fashionworks_core::catalog::{build, db, tint, visibility, Localization, TagIndex};
use serde_json::Value;

/// The slot whose piece a port holds, as `three/outfit.ts` maps them.
fn slot_of_port(port: &str) -> Option<&'static str> {
    Some(match port.to_ascii_lowercase().as_str() {
        "armor_helmet" => "helmet",
        "armor_torso" => "torso",
        "armor_arms" => "arms",
        "armor_legs" => "legs",
        "armor_undersuit" => "undersuit",
        "backpack" => "backpack",
        "hat_itemport" => "hat",
        "clothing_torso_1" => "jacket",
        "clothing_legs" => "trousers",
        _ => return None,
    })
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

fn passes(item: &Value, check: &Value) -> bool {
    let held = strings(&item["tagged"]);
    let has = |wanted: &str| held.iter().any(|h| visibility::holds(h, wanted));
    strings(&check["active"]).into_iter().all(has) && !strings(&check["disable"]).into_iter().any(has)
}

fn family(class_name: &str) -> String {
    class_name.split('_').take(5).collect::<Vec<_>>().join("_")
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dcb_path = args.next().expect("usage: visibility_probe <Game2.dcb> <global.ini> [class prefix]");
    let ini_path = args.next().expect("global.ini");
    let prefix = args.next().unwrap_or_default();
    let bytes = std::fs::read(&dcb_path).expect("reading Game2.dcb");
    let database = db::open(&bytes).expect("parsing DataCore");
    let raw = std::fs::read(&ini_path).expect("reading global.ini");
    let loc = Localization::parse(&String::from_utf8_lossy(&raw));
    let palettes = tint::PaletteIndex::build(&database);
    let makers = db::index_by_name(&database, "SCItemManufacturer");
    let tags = TagIndex::build(&database);
    println!("{} tags in the tree", tags.len());

    let mut items: Vec<Value> = db::armor_records(&database)
        .filter_map(|r| build::build_item(&r.value, &palettes, &makers, &loc, &tags, "male", &r.source_path))
        .collect();
    let untrimmed: usize = items.iter().map(|i| i["tagged"].to_string().len()).sum();
    visibility::keep_read_tags(&mut items);
    let trimmed: usize = items.iter().filter_map(|i| i.get("tagged")).map(|t| t.to_string().len()).sum();

    let mut gear = fashionworks_core::build_gear(&database, &palettes, &makers, &loc, &tags);
    visibility::trim_tagged(&mut gear, &visibility::read_tags(&items));
    let conditional: Vec<&Value> = items.iter().filter(|i| i.get("visibility").is_some()).collect();
    println!("{} items, {} with a conditional chunk", items.len(), conditional.len());
    let mut seen = BTreeSet::new();
    for item in conditional {
        let class_name = item["class_name"].as_str().unwrap_or("");
        if !class_name.starts_with(&prefix) {
            continue;
        }
        for chunk in item["visibility"].as_array().into_iter().flatten() {
            let line = format!("{} {} {}", family(class_name), chunk["zone"], chunk["when"]);
            if !seen.insert(line) {
                continue;
            }
            println!("{} ({}) {}", class_name, item["name"].as_str().unwrap_or(""), chunk["zone"].as_str().unwrap_or(""));
            for (n, condition) in chunk["when"].as_array().into_iter().flatten().enumerate() {
                for check in condition.as_array().into_iter().flatten() {
                    let ports = strings(&check["ports"]);
                    let slots: Vec<&str> = ports.iter().filter_map(|p| slot_of_port(p)).collect();
                    let families: BTreeSet<String> = items
                        .iter()
                        .filter(|other| slots.iter().any(|s| other["slot"] == *s))
                        .filter(|other| passes(other, check))
                        .map(|other| family(other["class_name"].as_str().unwrap_or("")))
                        .collect();
                    // A holster or the hand holds gear.
                    let gear_families: BTreeSet<String> = gear
                        .iter()
                        .filter(|g| passes(g, check))
                        .map(|g| family(g["class_name"].as_str().unwrap_or("")))
                        .collect();
                    let shown = if slots.is_empty() {
                        format!("gear: {} of {} pass{}", gear.iter().filter(|g| passes(g, check)).count(), gear.len(),
                            if gear_families.len() <= 6 { format!(" {gear_families:?}") } else { String::new() })
                    } else if families.len() > 12 {
                        format!("{} families", families.len())
                    } else {
                        format!("{families:?}")
                    };
                    println!("   condition {n}: {ports:?} -> {shown}");
                }
            }
        }
    }
    println!("tagged: {untrimmed} bytes as read, {trimmed} kept");
}
