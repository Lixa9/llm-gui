# Stage 1: Build Svelte frontend
FROM node:22-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Bun runtime
FROM oven/bun:1-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/bun.lockb* ./
RUN bun install --production

COPY server/ .
COPY --from=build /app/dist ./static
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN mkdir -p /data /app/config && \
    chown -R bun:bun /app /data && \
    chmod +x /docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)" || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
