# Stage 1: Build the Svelte frontend
FROM node:26-alpine AS build-frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Install only runtime dependencies and run TypeScript natively
FROM node:26-alpine
WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev
COPY --chown=node:node server/src ./src
COPY --chown=node:node --from=build-frontend /app/dist ./static

RUN mkdir -p /app/config && chown node:node /app/config

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --eval "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

USER node

CMD ["node", "src/index.ts"]
