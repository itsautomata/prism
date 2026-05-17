#!/usr/bin/env bash
#
# build tree-sitter grammar wasms from wasm/manifest.json.
#
# strategy:
#   - clone each grammar's source repo into wasm/sources/<name> at the pinned ref
#   - run `tree-sitter build --wasm` per grammar (docker or local emscripten)
#   - move the resulting .wasm into wasm/build/
#
# skip-tolerant: a single grammar failing logs the error and continues. the
# final report lists every success and every failure with the underlying reason.
#
# requires:
#   - git, jq, node, npx
#   - either docker (default) or emscripten installed
#
# run from prism repo root:
#   ./scripts/build-wasms.sh

# neither set -e (per-grammar failures must not abort the run)
# nor set -u (empty arrays under macOS bash 3.x trip this with a false alarm at exit time).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/wasm/manifest.json"
SOURCES_DIR="$ROOT/wasm/sources"
BUILD_DIR="$ROOT/wasm/build"

mkdir -p "$SOURCES_DIR" "$BUILD_DIR"

# fail early if jq missing
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found. install with 'brew install jq' or your package manager." >&2
  exit 1
fi

# resolve a tree-sitter CLI. precedence:
#   1. local node_modules/.bin (matches the runtime ABI from web-tree-sitter)
#   2. system install on $PATH
#   3. npx fallback
TS_CLI=""
if [ -x "$ROOT/node_modules/.bin/tree-sitter" ]; then
  TS_CLI="$ROOT/node_modules/.bin/tree-sitter"
elif command -v tree-sitter >/dev/null 2>&1; then
  TS_CLI="tree-sitter"
else
  TS_CLI="npx --yes tree-sitter-cli"
  echo "note: using 'npx tree-sitter-cli' (slower first run; consider 'npm install' to get the devDep)."
fi
echo "tree-sitter cli: $TS_CLI"

# parse manifest into shell-friendly lines: name|source|ref|subdir
ENTRIES=$(jq -r '.grammars[] | [.name, .source, .ref, (.subdir // "")] | @tsv' "$MANIFEST")

SUCCESS=()
FAILED=()

while IFS=$'\t' read -r NAME SOURCE REF SUBDIR; do
  [ -z "$NAME" ] && continue

  echo
  echo "=== $NAME ($REF) ==="
  SRC_PATH="$SOURCES_DIR/$NAME"

  # clone if missing; otherwise reuse (assume pinned, idempotent)
  if [ ! -d "$SRC_PATH/.git" ]; then
    if ! git clone --depth 1 --branch "$REF" "$SOURCE" "$SRC_PATH" 2>/dev/null; then
      # fall back to a full clone + checkout for refs that aren't tags/branches
      rm -rf "$SRC_PATH"
      if ! git clone "$SOURCE" "$SRC_PATH"; then
        FAILED+=("$NAME: git clone failed")
        continue
      fi
      if ! (cd "$SRC_PATH" && git checkout "$REF"); then
        FAILED+=("$NAME: checkout '$REF' failed")
        continue
      fi
    fi
  fi

  # locate the grammar dir (root, or subdir if specified)
  GRAMMAR_DIR="$SRC_PATH"
  if [ -n "$SUBDIR" ]; then
    GRAMMAR_DIR="$SRC_PATH/$SUBDIR"
  fi

  if [ ! -f "$GRAMMAR_DIR/grammar.js" ]; then
    FAILED+=("$NAME: grammar.js not found in $GRAMMAR_DIR")
    continue
  fi

  # some grammars don't commit the generated parser.c; run `tree-sitter
  # generate` first when it's missing. harmless to re-run when it's present.
  if [ ! -f "$GRAMMAR_DIR/src/parser.c" ]; then
    if ! (cd "$GRAMMAR_DIR" && $TS_CLI generate 2>/dev/null); then
      FAILED+=("$NAME: tree-sitter generate failed (parser.c missing)")
      continue
    fi
  fi

  # build the wasm. tree-sitter writes the output to the grammar dir as
  # tree-sitter-<name>.wasm.
  if ! (cd "$GRAMMAR_DIR" && $TS_CLI build --wasm); then
    FAILED+=("$NAME: tree-sitter build --wasm failed")
    continue
  fi

  # find the wasm (some grammars name by directory, others by package)
  WASM_FILE=$(find "$GRAMMAR_DIR" -maxdepth 1 -name "tree-sitter-*.wasm" -type f | head -1)
  if [ -z "$WASM_FILE" ]; then
    FAILED+=("$NAME: no tree-sitter-*.wasm produced in $GRAMMAR_DIR")
    continue
  fi

  # normalize to a stable filename: tree-sitter-<manifest-name>.wasm
  DEST="$BUILD_DIR/tree-sitter-$NAME.wasm"
  mv "$WASM_FILE" "$DEST"
  SUCCESS+=("$NAME")
  echo "  ok → $DEST"
done <<<"$ENTRIES"

echo
echo "=== summary ==="
echo "succeeded: ${#SUCCESS[@]}"
for n in "${SUCCESS[@]}"; do echo "  ✓ $n"; done
echo
echo "failed: ${#FAILED[@]}"
for f in "${FAILED[@]}"; do echo "  ✗ $f"; done

# exit non-zero if anything failed, so CI catches regressions
if [ ${#FAILED[@]} -gt 0 ]; then
  exit 1
fi
