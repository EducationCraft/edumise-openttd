# EduCraft fork of OpenTTD

Everything EduCraft-specific lives in this directory. The game itself is untouched
upstream code, so merging new OpenTTD releases stays a fast-forward.

OpenTTD is GPL-2.0 and so is this fork. The build is served from its own domain
(`ottd.edumise.educraft.cz`) rather than bundled into the EduMise Vite build — that
keeps EduMise from becoming a derivative work.

## Build

```bash
./educraft/build-web.sh      # docker + emscripten, ~15 min cold
```

Output in `build/`: `openttd.html`, `openttd.js`, `openttd.wasm`, `openttd.data`
(~13 MB total). The build has no pthreads and no `SharedArrayBuffer`, so the page
needs no COOP/COEP headers.

## The gate

`index.html` + `brana.js` sit in front of the game. They ask
`POST https://api.educraft.cz/auth/refresh` (credentials included) for the shared
`educraft_session` cookie, and only then load `openttd.html` in an iframe.

The gate is client-side only. The cookie is scoped `Path=/auth`, so CloudFront on this
domain never sees it and cannot check it — a real lock would mean Lambda@Edge. The game
holds no pupil data and is public GPL software, so the gate keeps pupils from wandering
in, not an attacker out.

The origin `https://ottd.edumise.educraft.cz` must stay in `CorsHelper.ALLOWED_ORIGINS`
(`rustometr-backend/public`), or the browser blocks the refresh call.

## Deploy

```bash
aws s3 cp build/openttd.wasm s3://ottd.edumise.educraft.cz/openttd.wasm \
  --content-type application/wasm --cache-control "public, max-age=86400"
aws s3 cp build/openttd.js   s3://ottd.edumise.educraft.cz/openttd.js \
  --content-type "application/javascript; charset=utf-8" --cache-control "public, max-age=86400"
aws s3 cp build/openttd.data s3://ottd.edumise.educraft.cz/openttd.data \
  --content-type application/octet-stream --cache-control "public, max-age=86400"
aws s3 cp build/openttd.html s3://ottd.edumise.educraft.cz/openttd.html \
  --content-type "text/html; charset=utf-8" --cache-control no-cache
aws s3 cp educraft/index.html s3://ottd.edumise.educraft.cz/index.html \
  --content-type "text/html; charset=utf-8" --cache-control no-cache
aws s3 cp educraft/brana.js  s3://ottd.edumise.educraft.cz/brana.js \
  --content-type "application/javascript; charset=utf-8" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id E14AEJ36SUV76M --paths "/*"
```

Filenames are fixed, so the one-day cache plus an invalidation is what makes a new build
visible. CloudFront `E14AEJ36SUV76M`, response headers policy `educraft-csp-game`
(separate from `educraft-csp-enforce`, which 14 other distributions share and which must
not be widened with `'wasm-unsafe-eval'`).

## Not built yet

Multiplayer. A browser cannot host a server and cannot speak raw TCP, so a class playing
together needs a dedicated `openttd -D` server plus a WebSocket proxy, and a patch to
`os/emscripten/pre.js` pointing at it. That is the first thing in this repo that would
actually touch upstream code.
