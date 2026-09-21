//! What the port resolves for one record, step by step: its attach type, its
//! name key, what that key resolves to, and whether `build_item` produces
//! anything.
//!
//! Kept because "the port and the pipeline disagree about this one item" is a
//! recurring question and the answer is always one of these four lines. It is
//! what turned up `@LOC_EMPTY` -- a name key that resolves to the empty string,
//! which `unwrap_or` happily keeps and Python's `or` discards.
use fashionworks_core::catalog::{db, Localization};

fn main() {
    let dcb = std::env::args().nth(1).expect("dcb");
    let ini = std::env::args().nth(2).expect("ini");
    let needle = std::env::args().nth(3).expect("class name substring");
    let bytes = std::fs::read(&dcb).expect("dcb");
    let database = db::open(&bytes).expect("parse");
    let raw = std::fs::read(&ini).expect("ini");
    let loc = Localization::parse(&String::from_utf8_lossy(&raw));

    for record in db::armor_records(&database) {
        if !record.class_name.contains(&needle) {
            continue;
        }
        let key = fashionworks_core::catalog::name_key(&record.value);
        println!("class      {}", record.class_name);
        println!("attach     {:?}", fashionworks_core::catalog::raw_attach_type(&record.value));
        println!("name_key   {key:?}");
        println!("resolved   {:?}", key.and_then(|k| loc.get(k)));
        let palettes = fashionworks_core::catalog::PaletteIndex::build(&database);
        let makers = db::index_by_name(&database, "SCItemManufacturer");
        let built = fashionworks_core::catalog::build_item(
            &record.value, &palettes, &makers, &loc, "male", &record.source_path);
        match built {
            None => println!("build_item None"),
            Some(item) => println!(
                "build_item slot={} geom={} flags={}",
                item["slot"], item["geometry"], item["flags"]),
        }
        println!();
    }
}
