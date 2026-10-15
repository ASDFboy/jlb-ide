#!/usr/bin/env bash
# Runs the self-test (src/selftest.js) inside the real desktop app: a debug build,
# on a virtual screen if there's no display. Prints the results; exits 1 on a failure.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build:web >/dev/null 2>&1
(cd src-tauri && cargo build >/dev/null 2>&1)
T=$(mktemp -d)
printf 'PRINT("hello", 1 + 2) >> needle_7731\n' > "$T/main.jlb"
printf 'hello 3\n' > "$T/main.out"
printf 'i = 0\nWHILE i < 30000 {\n    i += 1\n    PRINT("line", i)\n}\n' > "$T/flood.jlb"
LOG=$(mktemp)
APP="$PWD/src-tauri/target/debug/jlb-ide"
RUN=(); [ -z "${DISPLAY:-}" ] && RUN=(xvfb-run -a)
(cd "$T" && JLB_IDE_SELFTEST="$T" JLB_IDE_CONFIG="$(mktemp -d)" "${RUN[@]}" "$APP" >"$LOG" 2>&1) &
for _ in $(seq 1 120); do [ -f "$T/selftest.json" ] && break; sleep 1; done
kill %1 2>/dev/null || true
pkill -P $$ 2>/dev/null || true
[ -f "$T/selftest.json" ] || { echo "The app didn't finish the self-test:"; tail -20 "$LOG"; exit 1; }
cat "$T/selftest.json"
! grep -q '"\(FAILED\|ERROR\)' "$T/selftest.json"
