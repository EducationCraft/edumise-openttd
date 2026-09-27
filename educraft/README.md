# EduCraft fork of OpenTTD

Everything EduCraft-specific lives in this directory, the GameScript in
`bin/game/edumise_dane`, and a small, listed set of upstream patches (see
"Upstream diff" below). Keep that list short and complete, so merging a new OpenTTD
release stays a matter of re-checking those hunks.

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
Apart from that, `src/settings.cpp` (`GameLoadConfig`, `__EMSCRIPTEN__` only) picks the
`EduMise — daně` GameScript when none is configured, so a class never starts without taxes.
The `.nut` files carry a UTF-8 BOM on purpose: without it Squirrel reads them as ASCII and
Czech text comes out garbled. The alternative, adding
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

## EduMise Doprava: class server and wallet (pilot)

The class plays on one dedicated server per class; pupils pay for company money and
cosmetics with wallet diamonds. The binding spec is `educraft-wallet/docs/CONTRACT.md`
(§4.4 GameScript, §5 server patches). Game-server container, WSS proxy and bridge are
part B of the contract and not in this directory yet.

**Build the WASM client from the same commit as the server.** `LOAN_INTERVAL` runs inside
loan commands on both sides, so a client from another SHA desyncs. The Docker image tag of
the server must equal the SHA of the deployed `openttd.wasm`.

### Native dedicated server

```bash
cmake -S . -B build-dedicated -DOPTION_DEDICATED=ON -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build-dedicated -j"$(nproc)" --target openttd openttd_test
build-dedicated/openttd_test "Edu*,LOAN*"          # C++ unit tests of the patches
python3 educraft/server/gs_harness.py              # GameScript + server, ~5 min
python3 educraft/server/gs_harness.py --slow       # + 13 game months of insolvency, ~20 min
```

`build-*` is git-ignored. The harness needs OpenGFX, by default from `build/baseset`
(filled by `build-web.sh`; pass `--baseset DIR` otherwise). It runs the server on random
loopback ports in a temp dir with `educraft/server/openttd.cfg` plus three test-only
changes (insecure admin login with a password, GS setting `ladeni=1`, the ports) and
plays the bridge over the admin port: deposits, dedup, gaps, bindings, cosmetics with
cost compensation, loan-init, rescue, hold, save/load, watchdog and the session limit.
The client-socket hooks (A3, A5) are tested through `educraft/server/game_client.py`, a
scripted game client that joins over the real, encrypted game protocol (monocypher's
X25519 + XChaCha20-Poly1305 in pure Python) and sends raw moves and commands: a
`NEW_COMPANY` join on a full server, moves and `CompanyControl New` without admission,
gated commands next to an ungated loan, and a stale admission after `reset_company`.
It reads packet and command numbers from the C++ headers.

`educraft/server/openttd.cfg` is the server config (§5 A6, §6.2). Its `[version]
ini_version` line matters: without it OpenTTD treats the file as older than the
private/secrets split and silently ignores `private.cfg`, where the entrypoint puts
`[admin_authorized_keys]` and `[server_bind_addresses]` (127.0.0.1).

### GameScript

`edumise_dane` stays the only GameScript (OpenTTD runs one per game). Setting `penezenka`
(default 0) switches on the wallet protocol in `wallet.nut`; with 0 the script is exactly
the tax script the web single-player uses. `ladeni` enables test-only `debug` messages
and must stay 0 on servers.

Loan-init tops a new company up to its current loan (`delta = loan − cash`) and repays it
all. With the untouched initial loan that is `13924 − cash`; it also ends at 0/0 when a
pupil repaid part of the loan before the script ran. The top-up is capped at £100, which
covers the native charges (a month of interest and the monthly fee); a bigger gap is pupil
spending and goes to a human as `loaninit ok:false` instead of being refunded.

### Upstream diff

| File | Why |
|---|---|
| `src/economy_type.h` | A1: `LOAN_INTERVAL = 3481`, so the max loan £13,924 = 200 💎 is exactly 4 steps. Affects every build, single-player too. |
| `src/table/settings/network_settings.ini`, `src/settings_type.h` | A2: `network.edu_wallet_mode` (server-only, not saved, default off). |
| `src/network/network_edu.{h,cpp}`, `src/network/CMakeLists.txt` | A3/A5 logic: gated commands, admission map. New files, no upstream conflict. |
| `src/network/network_server.cpp` | Hooks, each behind `edu_wallet_mode`: join forced to spectator (A5a), gated client commands dropped with a chat line (A3), moves only as admitted, with the company allow-list skipped (A5b), `CompanyControl New` only with a `new` admission (A5c), admission erased on disconnect. |
| `src/company_cmd.cpp` | A5: `Company::PostDestructor` drops company admissions to the removed company, whose id the next new company reuses. |
| `src/console_cmds.cpp` | A5d: `edu_admit <client-id> <company-id\|new\|spectator>`, server only. |
| `src/script/api/script_town.{hpp,cpp}`, `game_changelog.hpp` | A4: `GSTown.GetTownActionCost(action)`, the exact native cost formula. |
| `src/table/settings/economy_settings.ini`, `src/settings_type.h`, `src/economy.cpp` | A7: `economy.edu_bankruptcy_hold` caps `months_of_bankruptcy` at 3, so an insolvent company is never offered for sale or removed. |
| `src/tests/test_edu_wallet.cpp`, `src/tests/CMakeLists.txt` | Unit tests for the gate, admission and loan step. |
| `src/settings.cpp` | Web build defaults to the tax GameScript (see above). |
| `src/table/settings/*.ini` (gui, locale, misc, old_gameopt, world) | Czech defaults: CZK, town names, language. |
| `os/emscripten/*`, `CMakeLists.txt` | CSP-safe shell, Czech in the WASM bundle. |

A7 deviates from the contract on purpose: the contract gates it with `edu_wallet_mode`,
but `CompanyCheckBankrupt` also runs on every client, where that server-only setting is
off, so client and server state would diverge. A game setting is saved in the map and
synced to clients; the server config turns it on for new games. It has no GUI entry and
no savegame version bump (settings load by name; an older save just keeps the default).
