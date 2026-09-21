//! Measure the Rust catalogue port against the Python manifest.
//!
//! WEB.md Phase 1's exit criterion is ≥99.5% field agreement on a full build,
//! so this is the instrument that says whether the phase is done. It runs
//! natively rather than through wasm because the DataCore layer takes bytes and
//! does not care where they came from, and native iteration is much faster.
//!
//!   cargo run --example catalog_diff --release -- \
//!       data/interim/dcbraw/Data/Game2.dcb data/out/manifest.json
//!
//! Only the fields the port actually covers yet are compared; each one prints
//! its own agreement so the number moves as the port grows rather than sitting
//! at zero until everything lands.

use std::collections::HashMap;
use std::time::Instant;

use fashionworks_core::catalog::{self, db};
use serde_json::Value;

fn main() {
    let mut args = std::env::args().skip(1);
    let dcb_path = args.next().expect("usage: catalog_diff <Game2.dcb> <manifest.json>");
    let manifest_path = args.next().expect("usage: catalog_diff <Game2.dcb> <manifest.json>");

    let t = Instant::now();
    let bytes = std::fs::read(&dcb_path).expect("reading Game2.dcb");
    println!("dcb       {:.1} MB read in {:?}", bytes.len() as f64 / 1e6, t.elapsed());

    let t = Instant::now();
    let database = db::open(&bytes).expect("parsing DataCore");
    println!("parse     {:?}", t.elapsed());

    let t = Instant::now();
    let records = db::armor_records(&database);
    println!("armour    {} records in {:?}\n", records.len(), t.elapsed());

    // The Python manifest, keyed the way the port keys its own output.
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).expect("reading manifest"))
            .expect("parsing manifest");
    let items = manifest["items"].as_array().expect("items");
    // A class name is not unique even inside the manifest: two items are both
    // called `gys_undersuit_01_01_01`, one with geometry and one flagged
    // `no_geometry`. Keeping only the last would score the port against the
    // empty one, so every candidate is kept and a field counts as agreeing if
    // it matches any of them.
    let mut expected: HashMap<&str, Vec<&Value>> = HashMap::new();
    for item in items {
        if let Some(name) = item["class_name"].as_str() {
            expected.entry(name).or_default().push(item);
        }
    }

    let mut tally = Tally::default();
    let mut missing = Vec::new();
    let mut npc = 0usize;

    for record in &records {
        // NPC-only gear never reaches the Python manifest, which drops it
        // unless --include-npc. Matching that here rather than counting it as
        // a disagreement.
        if catalog::flags_for(&record.class_name, None, true).iter().any(|f| f == "npc") {
            npc += 1;
            continue;
        }
        let Some(wants) = expected.get(record.class_name.as_str()) else {
            missing.push(record.class_name.clone());
            continue;
        };
        tally.matched += 1;

        // slot
        let got = catalog::slot_for(&record.attach_type).unwrap_or("");
        let ok = wants.iter().any(|w| got == w["slot"].as_str().unwrap_or(""));
        tally.check("slot", ok, || {
            format!("{}: slot {got:?} != {:?}", record.class_name, wants[0]["slot"])
        });

        // geometry: the worn mesh paths, in order
        let nodes = catalog::walk_geometry(&record.value);
        let got: Vec<&str> = catalog::select_wearables(&nodes, "male")
            .iter()
            .map(|n| n.path.as_str())
            .collect();
        let ok = wants.iter().any(|w| {
            let want_geo: Vec<&str> = w["geometry"]
                .as_array()
                .map(|a| a.iter().filter_map(|g| g["source"].as_str()).collect())
                .unwrap_or_default();
            got == want_geo
        });
        tally.check("geometry", ok, || {
            let want_geo: Vec<&str> = wants[0]["geometry"]
                .as_array()
                .map(|a| a.iter().filter_map(|g| g["source"].as_str()).collect())
                .unwrap_or_default();
            format!("{}: geometry {got:?} != {want_geo:?}", record.class_name)
        });

        // materials, including the per-gender fallback
        let got = catalog::materials_for(&nodes, "male");
        let ok = wants.iter().any(|w| {
            let want_mat: Vec<&str> = w["materials"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            got == want_mat
        });
        tally.check("materials", ok, || {
            let want_mat: Vec<&str> = wants[0]["materials"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            format!("{}: materials {got:?} != {want_mat:?}", record.class_name)
        });
    }

    println!("matched   {} of {} armour records against the manifest", tally.matched, records.len());
    println!("npc-only  {npc} dropped, as the Python drops them");
    if !missing.is_empty() {
        println!("unmatched {} (first few: {:?})", missing.len(), &missing[..missing.len().min(5)]);
    }
    println!();
    tally.report();
}

#[derive(Default)]
struct Tally {
    matched: usize,
    fields: Vec<(String, usize, usize, Vec<String>)>,
}

impl Tally {
    fn check(&mut self, field: &str, ok: bool, detail: impl FnOnce() -> String) {
        let entry = match self.fields.iter_mut().find(|(name, ..)| name == field) {
            Some(e) => e,
            None => {
                self.fields.push((field.to_string(), 0, 0, Vec::new()));
                self.fields.last_mut().unwrap()
            }
        };
        entry.1 += 1;
        if ok {
            entry.2 += 1;
        } else if entry.3.len() < 6 {
            entry.3.push(detail());
        }
    }

    fn report(&self) {
        println!("{:<12} {:>8} {:>8}  {}", "field", "agree", "of", "rate");
        for (name, total, ok, examples) in &self.fields {
            let rate = *ok as f64 / (*total).max(1) as f64;
            let flag = if rate >= 0.995 { "PASS" } else { "    " };
            println!("{name:<12} {ok:>8} {total:>8}  {:>6.2}%  {flag}", rate * 100.0);
            for e in examples {
                println!("               {e}");
            }
        }
    }
}
