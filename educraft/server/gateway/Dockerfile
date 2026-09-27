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
USER 1000:1000
EXPOSE 8080
CMD ["node", "main.js"]
