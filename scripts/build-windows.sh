#!/bin/bash
# Builds the Windows version from Linux (needs the x86_64-pc-windows-gnu Rust
# target, mingw-w64 and nsis). JLB_EXE and JLB_C_EXE are the Windows interpreters to bundle.
#   JLB_EXE=../jlb-rust/target/x86_64-pc-windows-gnu/release/jlb.exe scripts/build-windows.sh
# Results: windows/JLB-IDE-setup.exe (installer) and windows/portable/ (no install needed).
set -euo pipefail
cd "$(dirname "$0")/.."
JLB_EXE=${JLB_EXE:-../jlb-rust/target/x86_64-pc-windows-gnu/release/jlb.exe}
JLB_C_EXE=${JLB_C_EXE:-../jlb-c/windows/jlb-c.exe}
[ -f "$JLB_EXE" ] || { echo "Windows interpreter not found at $JLB_EXE"; exit 1; }
[ -f "$JLB_C_EXE" ] || echo "(No C interpreter at $JLB_C_EXE, so the C button won't be set up)"

# Bundle only the Windows interpreter.
stash=$(mktemp -d)
find src-tauri/interpreters -type f ! -name README.txt -exec mv {} "$stash"/ \;
cp "$JLB_EXE" src-tauri/interpreters/jlb.exe
[ -f "$JLB_C_EXE" ] && cp "$JLB_C_EXE" src-tauri/interpreters/jlb-c.exe
trap 'rm -f src-tauri/interpreters/jlb.exe src-tauri/interpreters/jlb-c.exe; mv "$stash"/* src-tauri/interpreters/ 2>/dev/null || true; rmdir "$stash"' EXIT

npx tauri build --target x86_64-pc-windows-gnu --bundles nsis

out=src-tauri/target/x86_64-pc-windows-gnu/release
mkdir -p windows/portable/interpreters
cp "$out"/bundle/nsis/*-setup.exe windows/JLB-IDE-setup.exe
cp "$out"/jlb-ide.exe windows/portable/JLB-IDE.exe
cp "$out"/WebView2Loader.dll windows/portable/
cp "$JLB_EXE" windows/portable/interpreters/jlb.exe
[ -f "$JLB_C_EXE" ] && cp "$JLB_C_EXE" windows/portable/interpreters/jlb-c.exe
ls -la windows windows/portable windows/portable/interpreters
