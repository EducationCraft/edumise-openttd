# EduMise Doprava — class game server

Contract: `educraft-wallet/docs/CONTRACT.md` §4–§6 (part B). One Fargate task per class game,
started only for a lesson (`desiredCount` 1/0 from the wallet):

```
browser WASM ──wss──▶ ALB :443 /g/<gameKey> ──▶ gateway:8080 ──tcp from 127.77.x.y──▶ openttd:3979
                                                 gateway ──admin port (X25519, encrypted)──▶ openttd:3977
                                                 gateway ──https M2M + X-Game-Token──▶ api.educraft.cz/wallet/game/*
```

| Path | What |
|---|---|
| `Dockerfile`, `entrypoint.sh`, `openttd.cfg` | native dedicated OpenTTD from this checkout + OpenGFX + the `EduMise — daně` GameScript |
| `gateway/` | Node 20: WSS proxy (tickets, loopback source IP per pupil), admin-port client, bridge to the wallet |
| `infra/` | CDK: VPC (public, no NAT), cluster `edumise-doprava`, ALB, EFS, ECR, one service per `games.json` entry |
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

Generate the admin key pair locally:

```bash
cd educraft/server/gateway && node --input-type=module -e "import {x25519} from '@noble/curves/ed25519.js';
const s=x25519.utils.randomSecretKey(); console.log(Buffer.from(s).toString('hex'), Buffer.from(x25519.getPublicKey(s)).toString('hex'))"
```

## Deploy (handover — not executed)

1. ACM certificate `doprava.edumise.educraft.cz` in **eu-central-1** (DNS validation). The CloudFront
   `*.edumise` cert is in us-east-1 and cannot be used by the ALB.
2. Put the SSM parameters above (per game after the wallet enrolled the class).
3. Push both images to ECR `edumise-doprava-server` / `edumise-doprava-gateway` with the SHA tag.
4. Add the class to `infra/games.json` (`{"gameKey": "c<12 hex of classId>"}`, value from the wallet), then
   `cdk deploy -c imageTag=<sha> -c certificateArn=<arn> -c adminPublicKey=<hex> -c walletClientId=<id>`.
5. DNS: `doprava.edumise.educraft.cz` → the ALB (alias / CNAME to the `AlbDns` output of the stack).
6. CSP `educraft-csp-game` (CloudFront `E14AEJ36SUV76M`): `connect-src 'self' https://api.educraft.cz wss://doprava.edumise.educraft.cz`.
7. Wallet side (§6.6): `ecs:UpdateService` / `ecs:DescribeServices` on `service/edumise-doprava/doprava-*`.
8. Rebuild and redeploy the WASM client from the same SHA (`educraft/build-web.sh`).

Never run two tasks of one game: the service uses `minHealthyPercent 0 / maxHealthyPercent 100`,
so a replacement stops the old task (and its SIGTERM save) before the new one starts.

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
