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

# Both tools are pinned to the revision this project was verified against.
# Following upstream HEAD meant every `setup` compiled and ran whatever had
# been pushed since, with this user's privileges, and a failed pull was
# swallowed so nobody could say which revision was built. Bump a pin
# deliberately, after reviewing the upstream diff.
STARBREAKER_REV="08302fbdd3a1cc704a0bc0977fb1841927a637bf"      # v0.3.2 line, 2026-05-20
CGF_CONVERTER_REV="7b951dbb254ab99f560e8ffbf64a771c70ccef74"    # Release/v2.0, 2026-06-21

clone_at() {
  local url="$1" dir="$2" rev="$3"
  if [[ ! -d "$dir/.git" ]]; then
    git init --quiet "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  if [[ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" == "$rev" ]]; then
    return
  fi
  git -C "$dir" fetch --quiet --depth 1 origin "$rev"
  if ! git -C "$dir" checkout --quiet --detach "$rev"; then
    echo "  $dir has local changes that block moving to $rev." >&2
    echo "  Reverse the web/patches (git -C \"$dir\" apply -R <patch>) and re-run." >&2
    exit 1
  fi
}

echo "== StarBreaker =="
if [[ ! -x "$CARGO" ]]; then
  echo "  cargo not found at $CARGO" >&2
  echo "  install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  exit 1
fi
clone_at https://github.com/diogotr7/StarBreaker.git "$SRC/StarBreaker" "$STARBREAKER_REV"

# The browser build needs things upstream does not expose yet. All of them are
# additive and default-off, so the native CLI built below is unaffected; see
# web/patches. Re-applied on every run; each one is skipped once it is in.
#
#   0001  gates the filesystem-only P4K API away from wasm32, and adds a
#         reader-based index entry point so a 158 GB archive can be read over
#         byte ranges.
#   0002  splits starbreaker-3d's byte parsers from its filesystem pipeline.
#         The pipeline needs MappedP4k, which does not exist on wasm32, and
#         the .blend writer needs zstd, a C library with no wasm target. Both
#         are now features, on by default.
#   0003  makes starbreaker-chf reject a hostile .chf instead of panicking:
#         a character file is something visitors share, and a panic under
#         panic = "abort" kills the browser worker.
for PATCH in "$ROOT"/web/patches/*.patch; do
  [[ -f "$PATCH" ]] || continue
  NAME="$(basename "$PATCH")"
  if git -C "$SRC/StarBreaker" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "  $NAME already applied"
  elif git -C "$SRC/StarBreaker" apply "$PATCH" 2>/dev/null; then
    echo "  $NAME applied"
  else
    echo "  $NAME did not apply; the web core would build without it" >&2
    exit 1
  fi
done

"$CARGO" build --release --locked --manifest-path "$SRC/StarBreaker/Cargo.toml" -p starbreaker
ln -sf ../src/StarBreaker/target/release/starbreaker "$BIN/starbreaker"
"$BIN/starbreaker" --version

echo
echo "== Cryengine-Converter (optional) =="
if [[ -z "$WHICH_DOTNET" ]]; then
  echo "  dotnet not found; skipping. Install with: brew install dotnet"
else
  clone_at https://github.com/Markemp/Cryengine-Converter.git "$SRC/Cryengine-Converter" "$CGF_CONVERTER_REV"
  dotnet publish "$SRC/Cryengine-Converter" -c Release -r osx-arm64 \
    --self-contained false -o "$BIN/cgf" --nologo -v quiet
  echo "  published to $BIN/cgf (run via the $BIN/cgf-converter wrapper)"
fi

echo
echo "Done. Check with: extract/.venv/bin/scx doctor"
