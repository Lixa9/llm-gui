# Stage 1: Build Svelte frontend
FROM node:24-alpine AS build-frontend
WORKDIR /app
RUN npm install -g npm@latest
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Build server (bundle TS)
FROM node:24-alpine AS build-server
WORKDIR /app
RUN npm install -g npm@latest
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/ .
RUN node_modules/.bin/esbuild src/index.ts \
      --bundle --platform=node --target=node24 \
      --packages=external --format=esm --outfile=dist/index.js
RUN npm prune --omit=dev

# Stage 3: Clean runtime image
FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache gosu

COPY --chown=node:node --from=build-server /app/node_modules ./node_modules
COPY --chown=node:node --from=build-server /app/dist/index.js ./index.js
COPY --chown=node:node --from=build-frontend /app/dist ./static
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN mkdir -p /app/config && \
    chmod +x /docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --eval "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

USER node

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "index.js"]
