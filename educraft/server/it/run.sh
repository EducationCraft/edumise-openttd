#!/usr/bin/env bash
# Local docker-compose integration run (contract §8 B): real server + gateway.
#  1. the gateway and a probe join the admin port securely; and "rcon save current" land in /data/save/current.sav
#  2. a ticket-admitted WebSocket reaches the real game port through the gateway
#  3. a container restart loads the same map (same generation seed) from current.sav
#  4. current.sav missing while snapshots exist -> the entrypoint exits 1
# Needs the images from ../build.sh (TAG=<sha>) or TAG=local.
set -euo pipefail
cd "$(dirname "$0")"
GW=../gateway
export TAG=${TAG:-local}
export IT_DIR=$(mktemp -d)
export GAME_KEY=c000000000001
trap 'docker compose down -v >/dev/null 2>&1 || true; rm -rf "$IT_DIR"' EXIT

read -r SECRET PUBLIC < <(cd $GW && node --input-type=module -e "
import { x25519 } from '@noble/curves/ed25519.js';
const s = x25519.utils.randomSecretKey();
console.log(Buffer.from(s).toString('hex'), Buffer.from(x25519.getPublicKey(s)).toString('hex'));")
export ADMIN_PUBLIC_KEY=$PUBLIC
TICKET_KEY=$(openssl rand -hex 32)
S=$IT_DIR/secrets/edumise-doprava/prod
mkdir -p "$S/games/$GAME_KEY" "$IT_DIR/data"
chmod 777 "$IT_DIR/data"
echo "$SECRET" > "$S/admin-private-key"
echo local > "$S/wallet-client-secret"
echo local > "$S/games/$GAME_KEY/game-token"
echo "$TICKET_KEY" > "$S/games/$GAME_KEY/ticket-key"

wait_port() { for _ in $(seq 60); do (echo > /dev/tcp/127.0.0.1/$1) 2>/dev/null && return 0; sleep 1; done; return 1; }
vt() { (cd $GW && OPENTTD_ADMIN_SECRET=$SECRET OPENTTD_DATA=$IT_DIR/data GAME_KEY=$GAME_KEY TICKET_KEY=$TICKET_KEY \
  GATEWAY_PORT=8080 IT_PHASE=$1 ./node_modules/.bin/vitest run test/real-server.test.ts); }

docker compose up -d
wait_port 3977 && wait_port 8080
sleep 2 # the gateway's own admin connection first
vt first
docker compose logs gateway | grep -q '"msg":"admin connected"' || { echo "FAIL: gateway did not join the admin port"; docker compose logs gateway; exit 1; }

docker compose restart openttd
sleep 2 && wait_port 3977
vt restart

docker compose stop
rm "$IT_DIR/data/save/current.sav"
touch "$IT_DIR/data/snapshots/2026-09-01T08-00-00-000Z.sav"
set +e
docker compose run --rm --no-deps openttd >/dev/null 2>&1
code=$?
set -e
[ "$code" = 1 ] || { echo "FAIL: entrypoint exit $code with snapshots but no current.sav"; exit 1; }
echo "IT OK"
