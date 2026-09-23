#!/bin/sh
# Build the WebAssembly core into pkg/, which the web app's build emits.
set -eu
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/fashionworks_core.wasm
ls -la pkg/fashionworks_core_bg.wasm
