//! What does `parse_mtl` actually say about a file? The layer_diff harness
//! collapsed every failure into one count; this prints the error.
fn main() {
    for path in std::env::args().skip(1) {
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => { println!("{path}: unreadable: {e}"); continue }
        };
        let name = path.rsplit('/').next().unwrap_or(&path);
        match starbreaker_3d::mtl::parse_mtl(&bytes) {
            Ok(f) => println!("{name}: ok, {} submaterial(s): {:?}", f.materials.len(),
                f.materials.iter().take(4).map(|m| m.name.as_str()).collect::<Vec<_>>()),
            Err(e) => println!("{name}: ERROR {e}"),
        }
    }
}
