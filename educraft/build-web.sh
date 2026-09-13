#!/usr/bin/env bash
# Postavi OpenTTD do wasm podle os/emscripten/README.md. Bez `-it`, aby to slo
# spustit i mimo terminal. Vystup: build/openttd.{html,js,wasm,data}
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
RUN="docker run --rm -v $ROOT:$ROOT -u $(id -u):$(id -g) "

docker build -t emsdk-openttd os/emscripten

mkdir -p build-host build
$RUN --workdir "$ROOT/build-host" emsdk-openttd cmake .. -DOPTION_TOOLS_ONLY=ON
$RUN --workdir "$ROOT/build-host" emsdk-openttd make -j"$(nproc)" tools

$RUN --workdir "$ROOT/build" emsdk-openttd emcmake cmake .. \
  -DHOST_BINARY_DIR=../build-host -DCMAKE_BUILD_TYPE=Release -DOPTION_USE_ASSERTS=OFF
$RUN --workdir "$ROOT/build" emsdk-openttd emmake make -j"$(nproc)"

echo "BUILD OK"
ls -la build/openttd.html build/openttd.js build/openttd.wasm build/openttd.data
