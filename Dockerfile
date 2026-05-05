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

COPY server/package.json server/bun.lockb* ./
RUN bun install --production

COPY server/ .
COPY --from=build /app/dist ./static

# Copy completion sound to static dir
# (already included from frontend/static/ via vite build public dir)

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)" || exit 1

CMD ["bun", "run", "src/index.ts"]
