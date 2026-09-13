#!/bin/bash
# Build a browser bundle for an exported game project (tools/cli.py build ...).
#
#   packaging/web/build_web.sh <project dir> <generated BIOS dir> [rom] [bios]
#
# Produces <project dir>/web/{index.html,game.js,game.wasm,...}. Serve it with
# packaging/web/serve.py (COOP/COEP are required for pthreads).
#
# Isolated build/output directories: GBARECOMP_WEB_BUILD_DIR (runtime),
# GBARECOMP_WEB_GAME_BUILD_DIR (game library), GBARECOMP_WEB_OUT_DIR (bundle).
# The runtime is configured with -DGBARECOMP_WEB_HOST=ON: no SDL, no
# OffscreenCanvas; host_web.js, bootstrap.js and the AudioWorklet DSP bundle
# are always copied so JS-only changes reach the output without a ROM rebuild.
#
# Threading model: -sPROXY_TO_PTHREAD. main() and the whole guest run on a Web
# Worker, where the blocking run loop and present-in-place are legal; the
# page owns WebGL; the worker only publishes shared RGB/PCM. Generated
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
absolute_dir() { mkdir -p "$1"; (cd "$1" && pwd); }
B=$(absolute_dir "${GBARECOMP_WEB_BUILD_DIR:-$R/build-web-host}")
GAME_BUILD=$(absolute_dir "${GBARECOMP_WEB_GAME_BUILD_DIR:-$PROJECT/build-web-host}")
OUT=$(absolute_dir "${GBARECOMP_WEB_OUT_DIR:-$PROJECT/web}")
check_cache() {
  if [ -f "$1/CMakeCache.txt" ] && ! grep -Fxq "CMAKE_HOME_DIRECTORY:INTERNAL=$2" "$1/CMakeCache.txt"; then
    echo "error: CMake cache in $1 belongs to another source tree" >&2; exit 1
  fi
}
check_cache "$B" "$R"
check_cache "$GAME_BUILD" "$PROJECT"
for source in bios_recompiled.cpp bios_dispatch_table.cpp; do
  test -s "$BIOS_GEN/$source" || { echo "error: missing generated BIOS $source" >&2; exit 1; }
done

if ! command -v emcc > /dev/null; then
  # shellcheck disable=SC1091
  source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" > /dev/null
fi
echo "== runtime (wasm, pthreads) -> $B"
emcmake cmake -S "$R" -B "$B" -DCMAKE_BUILD_TYPE=Release \
  -DGBARECOMP_COMPILER_CACHE=OFF \
  -DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread \
  -DGBARECOMP_WEB_HOST=ON \
  -DGBARECOMP_GENERATED_BIOS_DIR="$BIOS_GEN" > "$B.configure.log"
grep -q "BIOS recompiled output present" "$B.configure.log" || {
  echo "error: runtime configure did not pick up the recompiled BIOS" >&2; exit 1; }
grep -q "host_backend=web" "$B.configure.log" || {
  echo "error: browser backend was not selected" >&2; exit 1; }
cmake --build "$B" --target gbarecomp_runtime gbarecomp_debug gbarecomp_gba \
  gbarecomp_armv4t gbarecomp_recompile_core gbarecomp_heal_gate -- -j"$JOBS"

echo "== game library (wasm, pthreads) -> $GAME_BUILD"
grep -q -- "-mtail-call" "$PROJECT/CMakeLists.txt" || {
  echo "error: $PROJECT/CMakeLists.txt predates guaranteed tail calls; regenerate it with tools/cli.py" >&2
  exit 1; }
emcmake cmake -S "$PROJECT" -B "$GAME_BUILD" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS=-pthread > /dev/null
cmake --build "$GAME_BUILD" -- -j"$JOBS"

echo "== link -> $OUT"
mkdir -p "$OUT"
em++ -O2 -std=c++20 -pthread -mtail-call \
  -I"$R/src/runtime" -I"$R/src/armv4t" -I"$R/src/gba" -I"$R/src/debug" \
  -I"$R/external/arm-recomp-core/profiles/armv4t_gba" \
  "$R/packaging/web/main.cpp" \
  -Wl,--start-group \
    "$B/libgbarecomp_runtime.a" "$B/libgbarecomp_debug.a" "$B/libgbarecomp_gba.a" \
    "$B/libgbarecomp_armv4t.a" "$B/libgbarecomp_recompile_core.a" \
    "$B/libgbarecomp_heal_gate.a" "$GAME_BUILD/libgbarecomp_game.a" \
  -Wl,--end-group \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=4 \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=16777216 \
  -sFORCE_FILESYSTEM -sEXPORTED_RUNTIME_METHODS=FS,ENV,addRunDependency,removeRunDependency \
  -sENVIRONMENT=web,worker -sEXIT_RUNTIME=1 \
  --profiling-funcs --emit-symbol-map \
  -o "$OUT/game.js"

echo "== independent AudioWorklet DSP"
em++ -O2 -std=c++20 -I"$R/src/runtime" "$R/src/runtime/host_web_audio_dsp.cpp" --no-entry \
  -sENVIRONMENT=worklet -sMODULARIZE=1 -sEXPORT_NAME=createGbrAudioDSP \
  -sSINGLE_FILE -sWASM_ASYNC_COMPILATION=0 -sFILESYSTEM=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAP16 -sINITIAL_MEMORY=16777216 \
  -o "$OUT/audio_dsp.js"
cat "$OUT/audio_dsp.js" "$R/packaging/web/audio_worklet.js" > "$OUT/audio_worklet_bundle.js"
cp "$R/packaging/web/index.html" "$R/packaging/web/host_web.js" "$R/packaging/web/bootstrap.js" "$R/packaging/web/audio_worklet.js" "$OUT/"
python3 - "$R" "$OUT" "$BIOS_GEN" "$PROJECT" <<'MANIFEST'
import hashlib,json,pathlib,subprocess,sys
root,out,bios,project=map(pathlib.Path,sys.argv[1:])
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
data={'abi':1,'host_backend':'web','revision':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),
      'emcc':subprocess.check_output(['emcc','--version'],text=True).splitlines()[0],
      'files':{p.name:digest(p) for p in out.iterdir() if p.is_file() and p.name in ['game.js','game.wasm','host_web.js','index.html','audio_worklet_bundle.js']},
      'inputs':{p.name:digest(p) for p in [bios/'bios_recompiled.cpp',bios/'bios_dispatch_table.cpp',project/'game.toml'] if p.exists()}}
(out/'manifest.json').write_text(json.dumps(data,indent=2)+'\n')
MANIFEST
if [ -n "$ROM" ]; then
  cp "$ROM" "$OUT/game.gba"
  printf 'self.GBARECOMP_ROM_SHA1 = "%s";\n' "$(shasum -a 1 "$ROM" | cut -d' ' -f1)" > "$OUT/rom_sha1.js"
fi
if [ -n "$BIOS" ]; then
  cp "$BIOS" "$OUT/gba_bios.bin"
fi
ls -la "$OUT" | grep -v ' \._'
echo "== done. serve with: python3 $R/packaging/web/serve.py $OUT"
