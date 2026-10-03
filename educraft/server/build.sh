#!/usr/bin/env bash
# Builds both images of the Doprava game server, tagged with the git SHA (contract §6.1).
# The server must come from the same SHA as the deployed WASM client, or clients cannot join.
set -euo pipefail
cd "$(dirname "$0")/../.."
SHA=$(git rev-parse HEAD)

# .git stays out of the docker context; .ottdrev carries the network revision instead
# (cmake/scripts/FindVersion.cmake). Only the hash part must match the WASM client.
cmake -DGENERATE_OTTDREV=1 -P cmake/scripts/FindVersion.cmake >/dev/null
trap 'rm -f .ottdrev' EXIT

docker build -f educraft/server/Dockerfile -t "edumise-doprava-server:$SHA" .
docker build -t "edumise-doprava-gateway:$SHA" educraft/server/gateway
echo "BUILD OK $SHA"
