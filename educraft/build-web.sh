#!/usr/bin/env bash
# Postavi OpenTTD do wasm podle os/emscripten/README.md. Bez `-it`, aby to slo
# spustit i mimo terminal. Vystup: build/openttd.{html,js,wasm,data}
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
RUN="docker run --rm -v $ROOT:$ROOT -u $(id -u):$(id -g) "
OPENGFX=8.0
OPENGFX_ZIP=$(mktemp -d)/opengfx.zip

docker build -t emsdk-openttd os/emscripten

mkdir -p build-host build
$RUN --workdir "$ROOT/build-host" emsdk-openttd cmake .. -DOPTION_TOOLS_ONLY=ON
$RUN --workdir "$ROOT/build-host" emsdk-openttd make -j"$(nproc)" tools

$RUN --workdir "$ROOT/build" emsdk-openttd emcmake cmake .. \
  -DHOST_BINARY_DIR=../build-host -DCMAKE_BUILD_TYPE=Release -DOPTION_USE_ASSERTS=OFF

# Zakladni grafika se zabaluje do balicku, nestahuje se za behu. Bez toho hra
# nastartuje a hned hlasi "Missing base graphics": wasm build si ji tahá z
# content service pres wss://bananas-server.openttd.org, coz nase CSP blokuje —
# a skolni notebook by ji stahoval znovu po kazdem vycisteni uloziste.
# OpenGFX je GPL-2.0, stejne jako hra.
if [ ! -f build/baseset/opengfx.obg ]; then
  curl -sL -o "$OPENGFX_ZIP" \
    "https://cdn.openttd.org/opengfx-releases/$OPENGFX/opengfx-$OPENGFX-all.zip"
  unzip -o -q "$OPENGFX_ZIP" -d "$(dirname "$OPENGFX_ZIP")"
  tar xf "$(dirname "$OPENGFX_ZIP")/opengfx-$OPENGFX.tar" -C build/baseset/ --strip-components=1
fi

$RUN --workdir "$ROOT/build" emsdk-openttd emmake make -j"$(nproc)"

echo "BUILD OK"
ls -la build/openttd.html build/openttd.js build/openttd.wasm build/openttd.data
