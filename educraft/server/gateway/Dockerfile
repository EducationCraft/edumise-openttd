# EduMise Doprava gateway (WSS proxy + bridge), contract §6.2. Build: ../build.sh
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/dist/main.js ./main.js
# Direct WSS listens on 443 as uid 1000; the file capability is the only privilege node gets.
RUN apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
 && setcap cap_net_bind_service=+ep "$(readlink -f /usr/local/bin/node)" \
 && apt-get purge -y libcap2-bin && rm -rf /var/lib/apt/lists/*
USER 1000:1000
EXPOSE 8080 443
CMD ["node", "main.js"]
