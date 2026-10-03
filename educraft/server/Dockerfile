# EduMise Doprava — native dedicated OpenTTD built from THIS checkout (contract §6.2).
# Build from the repo root, so the server and the WASM client come from the same SHA:
#   docker build -f educraft/server/Dockerfile -t edumise-doprava-server:$(git rev-parse HEAD) .
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config zlib1g-dev liblzma-dev liblzo2-dev \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cmake -S . -B /build -DOPTION_DEDICATED=ON -DCMAKE_BUILD_TYPE=Release \
      -DOPTION_USE_ASSERTS=OFF -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_BINDIR=games \
    && cmake --build /build -j"$(nproc)" \
    && DESTDIR=/out cmake --install /build
# Same OpenGFX as educraft/build-web.sh, so client and server agree on the base set.
ARG OPENGFX=8.0
RUN curl -sfL -o /tmp/opengfx.zip "https://cdn.openttd.org/opengfx-releases/$OPENGFX/opengfx-$OPENGFX-all.zip" \
    && unzip -q /tmp/opengfx.zip -d /tmp \
    && mkdir -p /out/usr/share/games/openttd/baseset \
    && tar xf /tmp/opengfx-$OPENGFX.tar -C /out/usr/share/games/openttd/baseset --strip-components=1 \
    && mkdir -p /out/usr/share/games/openttd/game \
    && cp -r /src/bin/game/edumise_dane /out/usr/share/games/openttd/game/

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends zlib1g liblzma5 liblzo2-2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 openttd && useradd -u 1000 -g 1000 -M -d /data openttd \
    && mkdir -p /data /config && chown 1000:1000 /data /config
COPY --from=build /out/usr /usr
COPY --chown=1000:1000 educraft/server/openttd.cfg /config/openttd.cfg
COPY educraft/server/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV PATH=/usr/games:$PATH
USER 1000:1000
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
