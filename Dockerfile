# Stage 1: Build Svelte frontend
FROM node:22-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Node.js runtime
FROM node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gosu python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

COPY server/ .
COPY --from=build /app/dist ./static
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN mkdir -p /data /app/config && \
    chown -R node:node /app /data && \
    chmod +x /docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --eval "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
