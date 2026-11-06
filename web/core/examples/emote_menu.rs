//! The emote menu as the catalogue builds it (`catalog::emotes`): each kind,
//! whether the game offers it, and its variants' clips.
//!
//!   cargo run --example emote_menu --release -- <Game2.dcb> <global.ini> <playerEmoteAnims.adb>

use fashionworks_core::catalog::{db, emotes, Localization};

fn main() {
    let mut args = std::env::args().skip(1);
    let dcb = std::fs::read(args.next().expect("usage: emote_menu <Game2.dcb> <global.ini> <adb>")).expect("reading Game2.dcb");
    let ini = std::fs::read(args.next().expect("global.ini")).expect("reading global.ini");
    let adb = std::fs::read(args.next().expect("playerEmoteAnims.adb")).expect("reading the adb");
    let database = db::open(&dcb).expect("parsing DataCore");
    let loc = Localization::parse(&String::from_utf8_lossy(&ini));
    let record = db::index_by_name(&database, "ChatEmoteRecord");
    let Some(record) = record.values().next() else {
        println!("no ChatEmoteRecord");
        return;
    };
    let menu = emotes::build(record, &loc, &adb);
    let variants: usize = menu.iter().map(|e| e["variants"].as_array().map_or(0, Vec::len)).sum();
    println!("{} kinds, {variants} variants, {} adb fragments", menu.len(), emotes::fragments(&emotes::adb_text(&adb)).len());
    for e in &menu {
        let v = e["variants"].as_array().unwrap();
        let longest = v.iter().map(|s| s.as_array().map_or(0, Vec::len)).max().unwrap_or(0);
        println!(
            "{:<16} {:<6} {:>2} variant(s), longest {} clip(s)  {}",
            e["kind"].as_str().unwrap_or(""),
            if e["in_game"] == true { "" } else { "OFF" },
            v.len(),
            longest,
            e["text"].as_str().unwrap_or("")
        );
    }
}
