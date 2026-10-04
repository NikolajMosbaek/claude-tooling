#!/usr/bin/env bash
# Runs the mods' pure-logic tests under node. `claude plugin test` is the proper runner, but in
# Claude Code 2.1.287 it refuses to start ("the rollout switch served off"), so the tests that need
# no engine are bundled with `claude-code/testing` aliased to testing-shim.ts and run directly.
# Tests that import a hooks module (register.*) need the engine and are skipped here.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
status=0
for test in "$ROOT"/*/tests/*.test.ts; do
  if grep -q "hooks/register" "$test"; then
    echo "skip  ${test#$ROOT/} (needs the engine)"
    continue
  fi
  name="$(basename "$(dirname "$(dirname "$test")")")-$(basename "$test" .ts)"
  printf 'import "%s"\nimport { run } from "claude-code/testing"\nrun()\n' "$test" > "$OUT/$name.entry.ts"
  if ! npx -y esbuild@0.24 "$OUT/$name.entry.ts" --bundle --platform=node --format=esm \
      --alias:claude-code/testing="$ROOT/test-support/testing-shim.ts" \
      --outfile="$OUT/$name.mjs" --log-level=error; then
    status=1
    continue
  fi
  echo "== ${test#$ROOT/}"
  node "$OUT/$name.mjs" || status=1
done
exit $status
