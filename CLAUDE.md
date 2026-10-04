# EduMise OpenTTD (fork)

Fork OpenTTD pro EduMise Doprava: WASM klient v prohlizeci (`ottd.edumise.educraft.cz`) + dedikovany
server pro kazdou tridu (ECS Fargate), napojeny na diamantovou penezenku EduMise (`educraft-wallet`).
Vetev `educraft` = integracni vetev (zaklad pro PR).

**Podrobna dokumentace (architektura, zivotni cyklus hry, ekonomika, reset sveta, deploy runbook,
naklady) je v repu `EducationCraft/edumise-docs`** (lokalne `/devel/verca/educraft/edumise-docs`) —
pred vetsi zmenou ji precti tam. Zavazna specifikace penez a protokolu: `educraft-wallet/docs/CONTRACT.md`
(rozhodnuti D1–D24, §4 GameScript, §5 patche serveru, §6 server). Zde jsou jen zamery a invarianty.

## Co se nesmi rozbit

- **Single-player WASM musi dal fungovat.** Bez `#w=` v URL je to obycejna hra s danovym
  GameScriptem; `penezenka=0` = presne puvodni danovy skript.
- **Klient a server ze STEJNEHO git SHA.** Porovnava se jen git hash network revision; jiny SHA =
  desync / odmitnuty join. Tag Docker image serveru = SHA nasazeneho `openttd.wasm`.
- **Web build z plneho klonu, ne z worktree.** `build-web.sh` mountuje do Dockeru jen koren repa;
  `.git` worktree ukazuje mimo → build nezna revizi a vznikne klient, ktery se k serveru nepripoji.
- **Upstream diff minimalni** a kazdy hunk zapsany v `educraft/README.md` sekce „Upstream diff“.
  Vse EduCraft-specificke patri do `educraft/` a `bin/game/edumise_dane/`.
- **D1:** `LOAN_INTERVAL = 3481`, `max_loan = 13924` = 4 kroky = 200 💎 (3481 £ = 50 💎). Plati pro
  vsechny buildy vc. single-playeru.
- **Penize jen exactly-once pres wallet ops.** Jedna sekvence `seq` na hru (D4), GS aplikuje jen
  `lastSeq + 1` a drzi `lastSeq` + ring vysledku v savu. `seq` se NIKDY neresetuje — ani pri resetu
  sveta (novy svet navazuje od `baseSeq`, wallet ho pojmenuje `<gameKey>.<resetId>`).
- **GameScript je autorita pro penize ve hre** (deity mode): vklady, zachrany, granty/pokuty/dane
  starosty, startovni kapital. Bridge nic nepripisuje sam. GS vlastni i pauzu (D8).
- **Starosta = spectator** (D21): zadna firma, jen chat; pravomoci jen jako ops z webu.
- **Tymy = sloty 1–3 zaku, max 15** (= `max_companies`), meni se jen pres wallet `PUT …/slots` (D20).
  Vklady a dluh patri firme, ne tymu. Savegame je zdroj pravdy pro vazbu firma → slot (D17).
- **Admission vynucuje server** (patch A5, `edu_admit`), proxy dava kazdemu zakovi vlastni loopback IP (D6).
- **Zadne secrets v env.** Jen SSM SecureString `/edumise-doprava/prod/*` (tabulka v `educraft/server/README.md`).
- **Nikdy dva servery nad jednim savem:** ECS service `minHealthyPercent 0 / maxHealthyPercent 100`
  (stary task se ulozi na SIGTERM, az pak startuje novy). Entrypoint odmitne novou mapu, kdyz chybi
  `current.sav`, ale existuji snapshoty.
- `ladeni=0` na serverech (jen harness ma 1). `.nut` soubory maji UTF-8 BOM schvalne (cestina).
- CSP: zadne inline skripty; `educraft-csp-game` je oddelena policy, `educraft-csp-enforce` nerozsirovat.

## Zamery poslednich funkci

- **Startovni kapital** — dar (ne pujcka) `EDU_KAPITAL = 10 000 000 Kč` kazde firme po loan-init
  (`wallet.nut` `Kapital()`). `w.kapital[c]` = kolik uz dostala; zvyseni castky dorovna rozdil
  (`true` = stary 1 000 000 Kč). Neni to op ani zaznam ve walletu. GS setting `kapital=0` ho vypne
  (harness potrebuje firmy 0/0).
- **Reset sveta** (D24, „Resetovat svět“ v brane, jen pri `stopped`): wallet vrati zakum vklady,
  zrusi vazby firem, **tymy zustanou**. Bridge pri dalsim bootu dostane `reset_pending`, presune
  `save/` + `snapshots/` do `/data/archive/<resetId>/` a restartuje task; nova mapa se adoptuje s `baseSeq`.
  Kazdy krok je idempotentni (crash = opakovani pri dalsim bootu).
- **Cekani na dostupnost serveru** — wallet hlasi `running` uz po hello, ALB ale target zaradi o
  ~10–20 s pozdeji (503). Brana proto sonduje WebSocket bez listku (`serverOdpovida`, max 60 s),
  listek se nespotrebuje.
- **„Ukončit hru“** (spravce tridy) = `POST …/session {action:"stop"}`: server ulozi svet a vypne se;
  pristi spusteni pokracuje ze savu.
- **Jmeno hrace** jde z listku do WASM pres `#n=` (`os/emscripten/pre.js`); prazdne jmeno hra odmitne.

## Kde co je

| Cesta | Co |
|---|---|
| `educraft/README.md` | build webu, CSP, brana, deploy webu, **Upstream diff** |
| `educraft/index.html`, `educraft/brana.js` | brana: refresh session, vyber tridy/role, listek, start/stop/reset hry |
| `educraft/build-web.sh` | WASM build (Docker + emscripten, OpenGFX v balicku) |
| `educraft/server/README.md` | architektura serveru, SSM, odchylky od kontraktu |
| `educraft/server/gateway/` | Node 20: WSS proxy (`proxy.ts`), admin port (`admin.ts`), bridge na wallet (`bridge.ts`) |
| `educraft/server/infra/` | CDK: cluster `edumise-doprava`, ALB, EFS, ECR, service per `games.json` |
| `educraft/server/{Dockerfile,entrypoint.sh,openttd.cfg}` | dedikovany server; `ini_version` v cfg je nutny |
| `educraft/server/gs_harness.py`, `game_client.py`, `it/` | integracni testy GS + serveru |
| `bin/game/edumise_dane/` | GameScript: `main.nut` (dane), `wallet.nut` (protokol penezenky), `info.nut` (settings) |
| `src/network/network_edu.*`, `src/tests/test_edu_wallet.cpp` | C++ patche A3/A5 a jejich testy |

## Testy

```bash
cd educraft/server/gateway && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit
cd educraft/server/infra && ./node_modules/.bin/vitest run
cmake --build build-dedicated -j"$(nproc)" --target openttd openttd_test && build-dedicated/openttd_test "Edu*,LOAN*"
python3 educraft/server/gs_harness.py          # potrebuje build-dedicated/openttd + OpenGFX, ~5 min (--slow ~20 min)
```

Binarky volat primo, NIKDY `npm run` / `npm test`.

## Deploy

- Runbook: `EducationCraft/edumise-docs` + `educraft/README.md` (web) a `educraft/server/README.md` (server).
- Deploy serveru restartuje bezici tridni servery → nasazovat MIMO vyuku. Web a server vzdy ze stejneho SHA.

## Komunikace

- GitHub (issues, PR, commity) anglicky; UI texty cesky.
- Commity bez zminky o Claude/AI a bez `Co-Authored-By`.
