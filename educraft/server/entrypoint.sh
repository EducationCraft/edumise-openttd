#!/bin/sh
# EduMise Doprava — openttd container entrypoint (contract §6.2).
# A game that ever saved never silently gets a new map: the wallet would refuse its
# hello anyway (§4.6), so a missing current.sav next to existing snapshots is a hard stop.
set -eu

DATA=${DATA_DIR:-/data}
# With -c, OpenTTD uses the config file's folder as working dir, personal dir and the
# home of private.cfg (fileio.cpp DeterminePaths). The config therefore lives on /data,
# so "rcon save current" writes /data/save/current.sav. The image copy is authoritative.
CFG="$DATA/openttd.cfg"

if [ -z "${ADMIN_AUTHORIZED_KEY:-}" ]; then
  echo "entrypoint: ADMIN_AUTHORIZED_KEY is not set" >&2
  exit 1
fi

mkdir -p "$DATA/save" "$DATA/snapshots"
cd "$DATA"

cp /config/openttd.cfg "$CFG"
cat > "$DATA/private.cfg" <<CFG
[network]
server_name = EduMise Doprava
client_name = server

[server_bind_addresses]
127.0.0.1 =

[admin_authorized_keys]
$ADMIN_AUTHORIZED_KEY =
CFG

if [ -f "$DATA/save/current.sav" ]; then
  exec openttd -D -c "$CFG" -g "$DATA/save/current.sav"
fi

# Files only: OpenTTD itself creates the empty save/autosave folder at first start.
if [ -z "$(find "$DATA/save" "$DATA/snapshots" -type f)" ]; then
  exec openttd -D -c "$CFG"
fi

echo "entrypoint: $DATA/save/current.sav is missing but the game has saves or snapshots; refusing to start a new map (restore a snapshot, contract §6.5)" >&2
exit 1
