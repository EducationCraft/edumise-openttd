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
`src/openttd.cpp` no longer shows the survey prompt in the
main menu: pupils never see it, and the unanswered `ask` never sends a survey.

## The gate

`index.html` + `brana.js` sit in front of the game. They ask
`POST https://api.educraft.cz/auth/refresh` (credentials included) for the shared
`educraft_session` cookie, and only then load `openttd.html` in an iframe.

The gate is client-side only. The cookie is scoped `Path=/auth`, so CloudFront on this
domain never sees it and cannot check it — a real lock would mean Lambda@Edge. The game
holds no pupil data and is public GPL software, so the gate keeps pupils from wandering
in, not an attacker out.

**Teams.** Each class the teacher manages has *Týmy – <class>*: one number field (1–15) per pupil from
`GET /wallet/classes/<id>`, saved with `PUT /wallet/classes/<id>/slots` (every enrolled pupil exactly once,
at most 3 per team, one `requestId` per intent). A class with more than 15 pupils needs pairs here;
pupils without a team can only watch. Same rules as the EduMise teacher editor (`slotyZPrirazeni`).

**Second map** (EducationCraft/educraft-wallet#1, needs educraft-wallet PR #5 deployed; with an older wallet,
which sends no `maps[]`, and for every one-map class the gate behaves as before). A class that does not fit
into 15 companies gets map B. The gate reads `maps[]` from `GET /wallet/classes` and the class view:

- one *Spustit hru* starts both maps and waits until every map is `running` (it polls the class view once per
  map with `?map=`); stop, extend, resume and reset are one class action too. An error on one map is shown as
  *Mapa B: …*. When one map runs and the other does not, *Spustit hru* stays visible and starts the rest.
- a teacher sees one status line per map, a countdown per map and *Vstoupit jako starosta / Sledovat* per map
  (`game-ticket {map}`); *Hrát za žáka* lists the pupils of both maps.
- *Týmy* edits one map (`PUT …/slots {map}`), switches with *Týmy mapy A/B*, and moves a pupil with *→ B* /
  *→ A* (`PUT …/pupils/<id>/map`; a pupil with a company or deposits cannot move, the reason is shown in
  Czech). A moved pupil has no team until the teacher gives them one on the new map.
- *Založit druhou mapu* (in *Týmy*, only while the class has one map with more than 15 enrolled pupils)
  calls `POST …/maps` and shows the wallet's provisioning steps (two SSM keys, `games.json`, `cdk deploy`)
  for the operator. Until they are done the class cannot start (`409 game_server_not_provisioned`, map B).
  Each map is one ECS service, 9 of the stack's 500 CloudFormation resources.
- a pupil joins their own map automatically when it is their only live session apart from the sibling map
  of their class; otherwise the list labels the two maps *(mapa A)* / *(mapa B)*. The own map is picked by
  the wallet (`game-ticket {classId}`), any other map by `gameKey` (spectator).

`brana.js` and `index.html` only talk to the wallet API and to the game frame through the existing
postMessage/`#w=` protocol, which this change leaves alone, so they do not need a new WASM build or server
image and can be deployed on their own (the "same SHA" rule below is about `openttd.wasm` and the server).
Pure helpers are tested with `node --test educraft/brana.test.js` (in a browser the file exports nothing).

**Deposit from inside the game.** A pupil opens *Finance → Vklad diamantů* in the game: a native
window (`src/edu_wallet_gui.cpp`) shows the wallet balance, picks an amount with −10/−1/+1/+10/Vše
(no text field, so touch devices need no keyboard) and shows what the company gets in Kč. The game
never holds the token. It posts `edumise-wallet-get` / `edumise-deposit {amountTenths}` to the gate
(`pre.js` → `window.parent`), the gate calls `GET /wallet/me` / `POST /wallet/me/deposits` (one
`requestId` per click, `503 busy` retried with the same body) and answers
`edumise-wallet {walletTenths, hasCompany, deposit, message}`. Both sides check origin and source.
The gate sets `#p=1` only for a pupil playing in their own class (ticket role `pupil`), so mayors,
watchers of another class and "Hrát za žáka" see no menu item. A deposit stays locked in the game
until the answer to that deposit (`deposit: true`) comes back, also across closing the window; the
gate runs one deposit at a time and keeps its `requestId` until a 2xx/4xx answer. The open window
re-reads the state every 10 s. The money still arrives only as a wallet op through the GameScript.

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

Taxes follow Czech corporate income tax (header of `main.nut`, details in edumise-docs
`docs/ekonomika.md`): the return for calendar year Y is settled on 1 April Y+1 from
`GetAnnualExpenseValue(c, 1, …)`, with depreciation, loss carry-back/forward and advances
from the last known tax.

Loan-init tops a new company up to its current loan (`delta = loan − cash`) and repays it
all. With the untouched initial loan (`INITIAL_LOAN` rounded down to a step, £75,000) that is `75000 − cash`; it also ends at 0/0 when a
pupil repaid part of the loan before the script ran. The top-up is capped at £1,500 (61 500 Kč), which
covers the native charges (a month of interest and the monthly fee); a bigger gap is pupil
spending and goes to a human as `loaninit ok:false` instead of being refunded.

### Upstream diff

| File | Why |
|---|---|
| `src/economy_type.h` | A1: `LOAN_INTERVAL = 75000`, so the max loan £300,000 (12 300 000 Kč) is exactly 4 steps. Affects every build, single-player too. |
| `src/table/settings/network_settings.ini`, `src/settings_type.h` | A2: `network.edu_wallet_mode` (server-only, not saved, default off). |
| `src/network/network_edu.{h,cpp}`, `src/network/CMakeLists.txt` | A3/A5 logic: gated commands, admission map. New files, no upstream conflict. |
| `src/network/network_server.cpp` | Hooks, each behind `edu_wallet_mode`: join forced to spectator (A5a), gated client commands dropped with a chat line (A3), moves only as admitted, with the company allow-list skipped (A5b), `CompanyControl New` only with a `new` admission (A5c), admission erased on disconnect. |
| `src/company_cmd.cpp` | A5: `Company::PostDestructor` drops company admissions to the removed company, whose id the next new company reuses. |
| `src/console_cmds.cpp` | A5d: `edu_admit <client-id> <company-id\|new\|spectator>`, server only. |
| `src/script/api/script_town.{hpp,cpp}`, `game_changelog.hpp` | A4: `GSTown.GetTownActionCost(action)`, the exact native cost formula. |
| `src/script/api/script_company.{hpp,cpp}`, `game_changelog.hpp` | `GSCompany.GetAnnualExpenseValue(company, year_ago, type)`: one line of the finances window for the current or one of the two previous economy years, so the tax GameScript taxes exact calendar-year values. Runs in the web single-player too (same SHA). |
| `src/table/settings/economy_settings.ini`, `src/settings_type.h`, `src/economy.cpp` | A7: `economy.edu_bankruptcy_hold` caps `months_of_bankruptcy` at 3, so an insolvent company is never offered for sale or removed. |
| `src/tests/test_edu_wallet.cpp`, `src/tests/CMakeLists.txt` | Unit tests for the gate, admission and loan step. |
| `src/settings.cpp` | Web build defaults to the tax GameScript (see above). |
| `os/emscripten/pre.js` | §6.4: with `#w=<wss url>` the web client joins the class server `doprava:3979#255` (spectator) over the ticket URL, refreshed by the gate's `edumise-ticket` postMessage. With `#p=1` also the in-game wallet bridge (`Module.eduWallet`, `edumise-wallet` message). |
| `src/edu_wallet_gui.{h,cpp}`, `src/CMakeLists.txt` | In-game wallet window (deposit diamonds, see "The gate"). New files, raw Czech strings, no language file change. |
| `src/toolbar_gui.cpp`, `src/window_type.h`, `CMakeLists.txt` | Finances menu item "Vklad diamantů" (only when `Module.eduWallet` exists), `WindowClass::EduWallet`, export `_em_openttd_edu_wallet`. |
| `src/table/settings/*.ini` (gui, locale, misc, old_gameopt, world) | Czech defaults: CZK, town names, language. `misc.prefer_sprite_font` defaults to `true` so a fresh client uses the classic sprite font, not the bundled OpenTTD-Sans (OpenTTD 14+ default). Affects every build. |
| `os/emscripten/*`, `CMakeLists.txt` | CSP-safe shell, Czech in the WASM bundle. |

A7 deviates from the contract on purpose: the contract gates it with `edu_wallet_mode`,
but `CompanyCheckBankrupt` also runs on every client, where that server-only setting is
off, so client and server state would diverge. A game setting is saved in the map and
synced to clients; the server config turns it on for new games. It has no GUI entry and
no savegame version bump (settings load by name; an older save just keeps the default).
