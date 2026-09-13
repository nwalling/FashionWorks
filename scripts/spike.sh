#!/usr/bin/env bash
# One-set, end-to-end smoke test (PLAN.md §2 / Task 1).
#
# Prove the pipeline on a single armor set before generalising anything. Every
# step prints what it found; record the answers in CLAUDE.md -> "Verified facts"
# and do not move on to Task 2 until that section is filled in.
#
# Usage: scripts/spike.sh <set-name-fragment>   e.g. scripts/spike.sh pathfinder

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SET_FRAGMENT="${1:-}"
if [[ -z "$SET_FRAGMENT" ]]; then
  echo "usage: scripts/spike.sh <set-name-fragment>" >&2
  exit 2
fi

SCX="extract/.venv/bin/scx"
[[ -x "$SCX" ]] || { echo "no scx at $SCX; see README setup" >&2; exit 1; }

echo "== 0. host readiness =="
"$SCX" doctor

echo
echo "== 1. export the DataCore (filtered) =="
"$SCX" -v catalog --filter '**/*armor*' --game-version "${GAME_VERSION:-unknown}"

echo
echo "== 2. what did we get for '$SET_FRAGMENT'? =="
extract/.venv/bin/python - "$SET_FRAGMENT" <<'PY'
import json, sys, pathlib
fragment = sys.argv[1].lower()
manifest = json.loads(pathlib.Path("data/out/manifest.json").read_text())
hits = [i for i in manifest["items"] if fragment in i["class_name"].lower()]
print(f"{len(hits)} item(s) matched")
for item in hits:
    print(f"  {item['slot']:<10} {item['class_name']}")
    print(f"    name      {item['name']}")
    print(f"    geometry  {[g['source'] for g in item['geometry']]}")
    print(f"    materials {item['materials']}")
    print(f"    flags     {item['flags']}")
if not hits:
    print("RECORD THIS: the attach-type or geometry field guesses in "
          "extract/sc_extract/fields.py did not match the real export.")
PY

echo
echo "== 3. extract raw assets for the set =="
"$SCX" -v extract --slot helmet

echo
echo "== 4. build the canonical rig, then convert =="
echo "   Convert the skeleton .chr by hand first, then:"
echo "     $SCX rig --skeleton male"
echo "     $SCX convert --slot helmet"

echo
echo "== 5. check these by hand in Blender, and write the answers into CLAUDE.md =="
cat <<'NOTES'
  - Do the armor .skin bone names match the .chr skeleton exactly?
  - Is the exported bone set the full skeleton or a subset? (decides §5.3 A vs B)
  - Unit scale: 1.0 or 100x? Up axis: Z or Y?
  - Do vertex groups survive Cgf-Converter's glTF output, or is DAE needed?
  - Texture suffixes actually present (_diff/_ddna/_spec/...)?
NOTES
