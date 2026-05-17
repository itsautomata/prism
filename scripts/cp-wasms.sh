#!/usr/bin/env bash
#
# copy built grammar wasms from wasm/build/ into dist/wasm/ for the published
# bundle. runs as part of `npm run build`. tolerant of missing wasms (warn but
# don't fail) so a fresh clone can still build before `npm run build:wasms`
# has populated wasm/build/.
#
# run from prism repo root via:
#   npm run cp:wasms
# or directly:
#   ./scripts/cp-wasms.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/wasm/build"
DEST="$ROOT/dist/wasm"

mkdir -p "$DEST"

# shopt -s nullglob means an empty glob expands to nothing instead of the
# literal pattern, so the test below is honest about "no wasms found."
shopt -s nullglob
wasms=("$SRC"/*.wasm)

if [ ${#wasms[@]} -eq 0 ]; then
  echo "warning: no grammar wasms found in $SRC. run 'npm run build:wasms' first." >&2
  exit 0
fi

cp "${wasms[@]}" "$DEST/"
echo "copied ${#wasms[@]} grammar wasms to dist/wasm/"
