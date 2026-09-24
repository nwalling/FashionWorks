//! Look records up by GUID across the whole DataCore.
//!
//!   cargo run --release --example guid_probe -- <Game2.dcb> <guid>... [--json <dir>]
//!
//! A player's `.chf` names its body type, head material and textures by GUID,
//! and not all of them live under the item tree the catalogue exports. This
//! says what each one is -- struct type, record name, file -- and with
//! `--json` writes the record out for reading.

use std::str::FromStr;

use fashionworks_core::catalog::db;
use starbreaker_common::CigGuid;
use starbreaker_datacore::export;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let json_dir = args.iter().position(|a| a == "--json").map(|at| {
        let dir = args.get(at + 1).cloned().expect("--json <dir>");
        args.drain(at..=at + 1);
        dir
    });
    let dcb_path = args.first().cloned().expect("usage: guid_probe <Game2.dcb> <guid>...");
    let bytes = std::fs::read(&dcb_path).expect("reading Game2.dcb");
    let database = db::open(&bytes).expect("parsing DataCore");

    for text in &args[1..] {
        let Ok(guid) = CigGuid::from_str(text) else {
            println!("{text}: not a GUID");
            continue;
        };
        let Some(record) = database.record_by_id(&guid) else {
            println!("{text}: no record");
            continue;
        };
        let name = database.resolve_string2(record.name_offset);
        let file = database.resolve_string(record.file_name_offset);
        let kind = database.struct_name(record.struct_id());
        println!("{text}: {kind} {name}\n    {file}");
        if let Some(dir) = &json_dir {
            let mut buf = Vec::new();
            if export::write_json_compact(&database, record, &mut buf).is_ok() {
                let out = format!("{dir}/{text}.json");
                std::fs::write(&out, &buf).expect("writing JSON");
            }
        }
    }
}
