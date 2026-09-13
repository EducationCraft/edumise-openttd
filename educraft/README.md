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
(~18 MB total). The build has no pthreads and no `SharedArrayBuffer`, so the page
needs no COOP/COEP headers.

The script bundles OpenGFX into `build/baseset/` before linking. Upstream's wasm build
ships without base graphics and fetches them at first run over
`wss://bananas-server.openttd.org` — which the CSP blocks, so the game would start and
immediately say "Missing base graphics". Bundling also spares a school network the
download on every machine that clears its storage. OpenGFX is GPL-2.0, like the game.

## CSP and the shell

Two upstream things assume inline scripts are allowed, and the policy on this domain does
not allow them:

- the `<script>` block in `os/emscripten/shell.html`, which defines `Module` — without it
  `openttd.js` throws `Cannot read properties of undefined (reading 'push')` and the game
  hangs on "Loading ...";
- the `oncontextmenu` attribute on the canvas.

Both are moved into `os/emscripten/openttd-shell.js`, which ships next to `openttd.html`.
That is the whole reason this fork touches upstream files at all. The alternative, adding
`'unsafe-inline'` to `script-src`, would undo the main protection the policy gives.

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
  --content-type application/wasm --cache-control no-cache
aws s3 cp build/openttd.js   s3://ottd.edumise.educraft.cz/openttd.js \
  --content-type "application/javascript; charset=utf-8" --cache-control no-cache
aws s3 cp build/openttd.data s3://ottd.edumise.educraft.cz/openttd.data \
  --content-type application/octet-stream --cache-control no-cache
aws s3 cp build/openttd.html s3://ottd.edumise.educraft.cz/openttd.html \
  --content-type "text/html; charset=utf-8" --cache-control no-cache
aws s3 cp educraft/index.html s3://ottd.edumise.educraft.cz/index.html \
  --content-type "text/html; charset=utf-8" --cache-control no-cache
aws s3 cp educraft/brana.js  s3://ottd.edumise.educraft.cz/brana.js \
  --content-type "application/javascript; charset=utf-8" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id E14AEJ36SUV76M --paths "/*"
```

Filenames are fixed, so everything is served `no-cache`: the browser revalidates and a
redeploy is picked up at once, while unchanged bytes still come back as a 304. A long
`max-age` here is a trap — a CloudFront invalidation does not reach browsers that already
cached the old bundle, so a broken build would stick around for as long as the max-age.

Also upload `os/emscripten/openttd-shell.js` — the shell's script block lives there, not
inline, because the CSP forbids inline scripts (see below).

CloudFront `E14AEJ36SUV76M`, response headers policy `educraft-csp-game`
(separate from `educraft-csp-enforce`, which 14 other distributions share and which must
not be widened with `'wasm-unsafe-eval'`).

## Not built yet

Multiplayer. A browser cannot host a server and cannot speak raw TCP, so a class playing
together needs a dedicated `openttd -D` server plus a WebSocket proxy, and a patch to
`os/emscripten/pre.js` pointing at it. That is the first thing in this repo that would
actually touch upstream code.
