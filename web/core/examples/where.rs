//! Which record types carry a given name. Names come from the command line or,
//! with `-`, one per line on stdin.
//!
//! Kept because "which path is this record under, and is there an entity for it
//! at all" is the first question whenever the port and the pipeline disagree
//! about which items exist -- and the answer settled one: 140 manifest items
//! have no entity behind them, only a tint palette that happens to be named
//! like an armour piece.
use std::collections::{BTreeMap, HashSet};
use std::io::Read;

fn main() {
    let path = std::env::args().nth(1).expect("usage: where <Game2.dcb> <name>... | -");
    let mut needles: Vec<String> = std::env::args().skip(2).collect();
    if needles.first().map(String::as_str) == Some("-") {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).expect("stdin");
        needles = buf.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    }
    let wanted: HashSet<&str> = needles.iter().map(String::as_str).collect();

    let bytes = std::fs::read(&path).expect("dcb");
    let db = starbreaker_datacore::Database::from_bytes(&bytes).expect("parse");

    // name -> the set of record types carrying it.
    let mut found: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for record in db.records() {
        let full = db.resolve_string2(record.name_offset);
        let (ty, bare) = full.split_once('.').unwrap_or(("", full));
        if wanted.contains(bare) {
            found.entry(bare.to_string()).or_default().push(ty.to_string());
        }
    }

    let mut with_entity = 0;
    let mut palette_only = 0;
    let mut absent = 0;
    for name in &needles {
        match found.get(name.as_str()) {
            None => {
                absent += 1;
                println!("{name:<46} (no record of any type)");
            }
            Some(types) => {
                if types.iter().any(|t| t == "EntityClassDefinition") {
                    with_entity += 1;
                    if std::env::var("SHOW_ENTITY").is_ok() {
                        println!("ENTITY {name}");
                    }
                } else {
                    palette_only += 1;
                    if palette_only <= 5 {
                        println!("{name:<46} {}", types.join(", "));
                    }
                }
            }
        }
    }
    println!(
        "\n{} names: {with_entity} have an EntityClassDefinition, {palette_only} do not, {absent} absent",
        needles.len()
    );
}
