#!/usr/bin/env bash
# Build the extraction tools from source. Neither ships a macOS binary.
#
#   StarBreaker         Rust   -> tools/bin/starbreaker   (required)
#   Cryengine-Converter .NET   -> tools/bin/cgf-converter (optional cross-check)
#
# StarBreaker's `skin export` reads .skin/.cgf straight out of the P4K and
# writes GLB, so Cgf-Converter is only needed when a mesh's weights or bone
# hierarchy come out wrong and you want a second opinion.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/tools/src"
BIN="$ROOT/tools/bin"
mkdir -p "$SRC" "$BIN"

CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
WHICH_DOTNET="$(command -v dotnet || true)"

clone_or_update() {
  local url="$1" dir="$2"
  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" pull --ff-only --quiet || true
  else
    git clone --depth 1 "$url" "$dir"
  fi
}

echo "== StarBreaker =="
if [[ ! -x "$CARGO" ]]; then
  echo "  cargo not found at $CARGO" >&2
  echo "  install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  exit 1
fi
clone_or_update https://github.com/diogotr7/StarBreaker.git "$SRC/StarBreaker"

# The browser build needs two things upstream does not expose yet: the
# filesystem-only API gated away from wasm32, and a reader-based index entry
# point (`entries_from_reader`) so a 158 GB archive can be read over byte
# ranges. Both are additive; see web/patches. Re-applied after every pull
# because clone_or_update fast-forwards the checkout.
PATCH="$ROOT/web/patches/0001-starbreaker-p4k-browser-support.patch"
if [[ -f "$PATCH" ]]; then
  if git -C "$SRC/StarBreaker" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "  browser-support patch already applied"
  elif git -C "$SRC/StarBreaker" apply "$PATCH" 2>/dev/null; then
    echo "  browser-support patch applied"
  else
    echo "  WARNING: browser-support patch did not apply; the web core will not build" >&2
  fi
fi
"$CARGO" build --release --manifest-path "$SRC/StarBreaker/Cargo.toml" -p starbreaker
ln -sf ../src/StarBreaker/target/release/starbreaker "$BIN/starbreaker"
"$BIN/starbreaker" --version

echo
echo "== Cryengine-Converter (optional) =="
if [[ -z "$WHICH_DOTNET" ]]; then
  echo "  dotnet not found; skipping. Install with: brew install dotnet"
else
  clone_or_update https://github.com/Markemp/Cryengine-Converter.git "$SRC/Cryengine-Converter"
  dotnet publish "$SRC/Cryengine-Converter" -c Release -r osx-arm64 \
    --self-contained false -o "$BIN/cgf" --nologo -v quiet
  echo "  published to $BIN/cgf (run via the $BIN/cgf-converter wrapper)"
fi

echo
echo "Done. Check with: extract/.venv/bin/scx doctor"
