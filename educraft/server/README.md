# EduMise Doprava — class game server

Contract: `educraft-wallet/docs/CONTRACT.md` §4–§6 (part B). One Fargate task per class game,
started only for a lesson (`desiredCount` 1/0 from the wallet):

```
browser WASM ──wss──▶ <gameKey>.ottd-server.edumise.educraft.cz:443 ──▶ gateway:443 (TLS) ──tcp from 127.77.x.y──▶ openttd:3979
                                                 gateway ──admin port (X25519, encrypted)──▶ openttd:3977
                                                 gateway ──https M2M + X-Game-Token──▶ api.educraft.cz/wallet/game/*
```

| Path | What |
|---|---|
| `Dockerfile`, `entrypoint.sh`, `openttd.cfg` | native dedicated OpenTTD from this checkout + OpenGFX + the `EduMise — daně` GameScript |
| `gateway/` | Node 20: WSS proxy (tickets, loopback source IP per pupil), admin-port client, bridge to the wallet |
| `infra/` | CDK: VPC (public, no NAT), cluster `edumise-doprava`, EFS, ECR, one service per `games.json` entry, TLS renewal Lambda (`infra/lambda/renew-cert.ts`) |
| `it/` | local docker-compose run against the real server |

## Build and test

```bash
./educraft/server/build.sh                     # both images, tagged with the git SHA
cd educraft/server/gateway && npm ci && npm test && npm run typecheck
cd educraft/server/infra && npm ci && npm test
TAG=<sha> ./educraft/server/it/run.sh          # needs docker; Linux (network_mode: host)
```

The server image must be built from the same SHA as the deployed WASM client: only the git
hash of the network revision is compared, and `build.sh` passes it in via `.ottdrev`.

## Secrets (SSM SecureString, never env)

| Parameter | Value |
|---|---|
| `/edumise-doprava/prod/admin-private-key` | X25519 secret key of the bridge, hex. Its public key goes to the task as `ADMIN_AUTHORIZED_KEY` (context `adminPublicKey`). |
| `/edumise-doprava/prod/wallet-client-secret` | Cognito app client `edumise-doprava-bridge` secret |
| `/edumise-doprava/prod/games/<gameKey>/game-token` | `hex(HMAC-SHA256(gameTokenMaster, "game:"+gameKey))` |
| `/edumise-doprava/prod/games/<gameKey>/ticket-key` | `hex(HMAC-SHA256(ticketMaster, "ticket:"+gameKey))`; the gateway HMACs tickets with the hex-decoded bytes |
| `/edumise-doprava/prod/tls/bundle` | `{"cert","key"}` PEM of the Let's Encrypt wildcard `*.ottd-server.edumise.educraft.cz`. Written only by Lambda `edumise-doprava-tls-renew`, never by hand. |

Generate the admin key pair locally:

```bash
cd educraft/server/gateway && node --input-type=module -e "import {x25519} from '@noble/curves/ed25519.js';
const s=x25519.utils.randomSecretKey(); console.log(Buffer.from(s).toString('hex'), Buffer.from(x25519.getPublicKey(s)).toString('hex'))"
```

## Deploy (handover — not executed)

1. TLS: no ACM certificate; the renewal Lambda puts the wildcard into SSM `tls/bundle` (see below).
2. Put the SSM parameters above (per game after the wallet enrolled the class).
3. Push both images to ECR `edumise-doprava-server` / `edumise-doprava-gateway` with the SHA tag.
4. Add the class to `infra/games.json` (`{"gameKey": "c<12 hex of classId>"}`, value from the wallet), then
   `cdk deploy -c imageTag=<sha> -c adminPublicKey=<hex> -c walletClientId=<id> -c walletBase=<url>`.
5. DNS: nothing to do; each gateway writes its own `<gameKey>.ottd-server…` A record.
6. CSP `educraft-csp-game` (CloudFront `E14AEJ36SUV76M`): `connect-src 'self' https://api.educraft.cz wss://*.ottd-server.edumise.educraft.cz`.
7. Wallet side (§6.6): `ecs:UpdateService` / `ecs:DescribeServices` on `service/edumise-doprava/doprava-*`.
8. Rebuild and redeploy the WASM client from the same SHA (`educraft/build-web.sh`).

Never run two tasks of one game: the service uses `minHealthyPercent 0 / maxHealthyPercent 100`,
so a replacement stops the old task (and its SIGTERM save) before the new one starts.

## Direct access (no ALB)

The ALB cost a fixed ~$16–20/month for a few hours of lessons, so browsers connect straight to the
class's task. Who may connect is unchanged: the gateway admits only wallet tickets, OpenTTD listens on
`127.0.0.1` only, and the task security group opens nothing but 443.

- **Name.** At start the gateway UPSERTs `A <gameKey>.ottd-server.edumise.educraft.cz` (TTL 60, zone
  `Z05772991Q99U0Y3XXBDS`) to its public IP from `checkip.amazonaws.com`. The task role may change only
  that one record. A stopped task leaves the record pointing at a released IP: harmless, TLS fails
  there and the wallet issues tickets only for a live session.
- **TLS.** The gateway serves the same handler on :443 with `tls/bundle` (read once at start; a session
  lasts ≤ 4 h). The image gives `node` `cap_net_bind_service`, it still runs as uid 1000.
- **Certificate.** Lambda `edumise-doprava-tls-renew` runs daily at 03:00 UTC and renews when < 30 days
  are left (LE DNS-01, TXT `_acme-challenge.ottd-server…` only). First run after deploy:
  `aws lambda invoke --function-name edumise-doprava-tls-renew --region eu-central-1 /dev/stdout`
  → `{"renewed":true,"daysLeft":89}`.
- **Floods.** At most 300 sockets per listener (`MAX_CONNECTIONS`), WebSocket messages ≤ 1 MiB;
  a socket without a valid ticket is closed right after the handshake (4401).
- **Alarms → SNS `educraft-alerts`.** `edumise-doprava-tls-renew-failed` (renewal threw; 30 days of
  daily retries before expiry) and `edumise-doprava-direct-access-failed` (a gateway logged
  `direct access failed`: no bundle, :443 bind or DNS; nobody can join that class until it is fixed).
- **Client.** The wallet issues `wss://<gameKey>.ottd-server.edumise.educraft.cz/g/<gameKey>?t=…`;
  `pre.js` still accepts the old ALB host; drop it at the next client release. CSP `educraft-csp-game` needs
  `wss://*.ottd-server.edumise.educraft.cz` in `connect-src`.
- **ALB removed 2026-10-24** (stack, A alias `ottd-server.edumise.educraft.cz`, ACM cert). It took two
  deploys: CloudFormation does not detach target groups from an ECS service, so a task definition without
  8080 is rejected while the service still references one; after the ALB went the stale references were
  cleared with `aws ecs update-service --load-balancers '[]'` (desiredCount untouched).
  The gateway still listens on plain 8080 inside the task; no SG rule reaches it.

## Deviations from the contract text

- **Config on `/data`.** With `-c`, OpenTTD takes the config file's folder as working dir, personal dir
  and home of `private.cfg` (`fileio.cpp DeterminePaths`), so `-c /config/openttd.cfg` would save to
  `/config/save`. The entrypoint copies the image's `/config/openttd.cfg` to `/data/openttd.cfg` at
  every start and runs `-c /data/openttd.cfg`; saves land in `/data/save` as §6.2 intends.
- `openttd.cfg` needs `[version] ini_version = 8`, otherwise OpenTTD reads bind addresses and admin keys
  from `openttd.cfg` instead of `private.cfg`.
- A failed op travels as `noop`; the bridge posts no result for its ack (the op is already terminal).
- After `limit`, and before the session started (adopt), the bridge ends a save's `hold` with `hello`,
  not `session{run:true}`, so the game stays paused.
