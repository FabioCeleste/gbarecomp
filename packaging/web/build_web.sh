#!/bin/bash
# Build a browser bundle for an exported game project (tools/cli.py build ...).
#
#   packaging/web/build_web.sh <project dir> <generated BIOS dir> [rom] [bios]
#
# Produces <project dir>/web/{index.html,game.js,game.wasm,...}. Serve it with
# packaging/web/serve.py (COOP/COEP are required for pthreads).
#
# Threading model: -sPROXY_TO_PTHREAD. main() and the whole guest run on a Web
# Worker, where the blocking run loop and present-in-place are legal; the
# canvas is transferred to that worker (OFFSCREENCANVAS_SUPPORT). Generated
# code needs guaranteed tail calls, so everything is built with -mtail-call
# (runtime_arm.h refuses to compile otherwise).
#
# The recompiler itself never runs here: generate the project and the BIOS with
# a native build first. There is no self-heal compiler in a browser, so a web
# build is only honest for a game whose coverage is FULLY STATIC.
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,8p' "$0"
  exit 2
fi

R=$(cd "$(dirname "$0")/../.." && pwd)
PROJECT=$(cd "$1" && pwd)
BIOS_GEN=$(cd "$2" && pwd)
ROM=${3:-}
BIOS=${4:-}
JOBS=${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}
OUT="$PROJECT/web"

if ! command -v emcc > /dev/null; then
  # shellcheck disable=SC1091
  source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" > /dev/null
fi
SYSROOT=$(dirname "$(command -v emcc)")/cache/sysroot
embuilder build sdl2 sdl2-mt > /dev/null

echo "== runtime (wasm, pthreads) -> $R/build-wasm-mt"
emcmake cmake -S "$R" -B "$R/build-wasm-mt" -DCMAKE_BUILD_TYPE=Release \
  -DGBARECOMP_COMPILER_CACHE=OFF \
  -DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread \
  -DSDL2_INCLUDE_DIR="$SYSROOT/include/SDL2" \
  -DSDL2_LIBRARY="$SYSROOT/lib/wasm32-emscripten/libSDL2-mt.a" \
  -DGBARECOMP_GENERATED_BIOS_DIR="$BIOS_GEN" > "$R/build-wasm-mt.configure.log"
grep -q "BIOS recompiled output present" "$R/build-wasm-mt.configure.log" || {
  echo "error: runtime configure did not pick up the recompiled BIOS" >&2; exit 1; }
if grep -q "SDL2 NOT found" "$R/build-wasm-mt.configure.log"; then
  echo "error: SDL2 not found for the wasm runtime (host_window would be a stub)" >&2; exit 1
fi
cmake --build "$R/build-wasm-mt" --target gbarecomp_runtime gbarecomp_debug gbarecomp_gba \
  gbarecomp_armv4t gbarecomp_recompile_core gbarecomp_heal_gate -- -j"$JOBS"

echo "== game library (wasm, pthreads) -> $PROJECT/build-wasm-mt"
grep -q -- "-mtail-call" "$PROJECT/CMakeLists.txt" || {
  echo "error: $PROJECT/CMakeLists.txt predates guaranteed tail calls; regenerate it with tools/cli.py" >&2
  exit 1; }
emcmake cmake -S "$PROJECT" -B "$PROJECT/build-wasm-mt" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS=-pthread > /dev/null
cmake --build "$PROJECT/build-wasm-mt" -- -j"$JOBS"

echo "== link -> $OUT"
mkdir -p "$OUT"
B="$R/build-wasm-mt"
em++ -O2 -std=c++20 -pthread -mtail-call \
  -I"$R/src/runtime" -I"$R/src/armv4t" -I"$R/src/gba" -I"$R/src/debug" \
  -I"$R/external/arm-recomp-core/profiles/armv4t_gba" \
  "$R/packaging/web/main.cpp" \
  -Wl,--start-group \
    "$B/libgbarecomp_runtime.a" "$B/libgbarecomp_debug.a" "$B/libgbarecomp_gba.a" \
    "$B/libgbarecomp_armv4t.a" "$B/libgbarecomp_recompile_core.a" \
    "$B/libgbarecomp_heal_gate.a" "$PROJECT/build-wasm-mt/libgbarecomp_game.a" \
  -Wl,--end-group \
  -sUSE_SDL=2 \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=4 \
  -sOFFSCREENCANVAS_SUPPORT -sOFFSCREEN_FRAMEBUFFER \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=16777216 \
  -sFORCE_FILESYSTEM -sEXPORTED_RUNTIME_METHODS=FS,ENV,addRunDependency,removeRunDependency \
  -sENVIRONMENT=web,worker -sEXIT_RUNTIME=1 \
  --profiling-funcs --emit-symbol-map \
  -o "$OUT/game.js"

cp "$R/packaging/web/index.html" "$OUT/index.html"
if [ -n "$ROM" ]; then
  cp "$ROM" "$OUT/game.gba"
  printf 'self.GBARECOMP_ROM_SHA1 = "%s";\n' "$(shasum -a 1 "$ROM" | cut -d' ' -f1)" > "$OUT/rom_sha1.js"
fi
if [ -n "$BIOS" ]; then
  cp "$BIOS" "$OUT/gba_bios.bin"
fi
ls -la "$OUT" | grep -v ' \._'
echo "== done. serve with: python3 $R/packaging/web/serve.py $OUT"
