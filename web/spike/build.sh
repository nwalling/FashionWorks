#!/usr/bin/env bash
# Build the wasm core plus bindings for Node, a classic worker, and the app.
#
# Run this on the machine that has Rust. The output under pkg/ and pkg-web/ is
# self-contained, so the whole web/spike folder can then be copied to a Windows
# box with the game on it and served there without a Rust toolchain.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="$here/../core"
wasm="$core/target/wasm32-unknown-unknown/release/fashionworks_core.wasm"

command -v wasm-bindgen >/dev/null || {
  version=$(grep -A1 '^name = "wasm-bindgen"$' "$core/Cargo.lock" | sed -n 's/^version = "\(.*\)"/\1/p')
  echo "wasm-bindgen CLI missing; install the matching version with:" >&2
  echo "  cargo install wasm-bindgen-cli --version ${version:-0.2.128} --locked" >&2
  exit 1
}

rustup target list --installed | grep -q wasm32-unknown-unknown || \
  rustup target add wasm32-unknown-unknown

cargo build --manifest-path "$core/Cargo.toml" --target wasm32-unknown-unknown --release

# nodejs bindings drive the headless half of the spike; no-modules is what a
# classic worker can importScripts().
wasm-bindgen --target nodejs      --out-dir "$here/pkg"     "$wasm"
wasm-bindgen --target no-modules  --out-dir "$here/pkg-web" "$wasm"

# And an ES-module build for the app, whose worker is a module worker and whose
# bundler wants a real import rather than importScripts.
wasm-bindgen --target web         --out-dir "$core/pkg"     "$wasm"

size=$(wc -c < "$here/pkg-web/fashionworks_core_bg.wasm")
printf 'wasm %.0f KB raw' "$((size / 1024))"
if command -v brotli >/dev/null; then
  br=$(brotli -q 11 -c "$here/pkg-web/fashionworks_core_bg.wasm" | wc -c)
  printf ', %.2f MB brotli (budget: 2 MB)' "$(echo "$br / 1048576" | bc -l)"
fi
echo
