# LLM Chat Frontend

A self-hosted Svelte chat UI and OpenAI-compatible streaming relay. The server stores application state in PostgreSQL and does not run inference, tools, embeddings, RAG, or agent loops locally.

## Features

- Streaming chat with cancellation, regeneration, editing, forking, copying, and deletion.
- File attachments for common images, documents, spreadsheets, and text formats.
- Conversation search, folders, drag-and-drop, pinning, and inline folder creation.
- Personal prompts and model presets plus deployment-seeded shared definitions.
- Optional scheduled automations.
- OIDC SSO with two roles (`admin`, `user`).
- One fixed local `admin`/`admin` account can be explicitly enabled for testing only.

## Architecture

The web process is stateless. PostgreSQL stores conversations, messages, identities, sessions, preferences, uploads, rate-limit counters, and automation leases. Any replica can handle any request.

Uploaded bytes and extracted derivatives are stored in PostgreSQL, so the application has no required local data volume. Configuration files are deployment-owned and mounted read-only; they are reconciled into PostgreSQL at startup. The browser editor for server configuration has been removed.

Sessions use random opaque bearer tokens. Only a SHA-256 token hash is stored in PostgreSQL, with expiry and revocation checked on every request. No signing secret is placed in configuration or generated per instance.

The relay builds history from the canonical conversation in PostgreSQL. It does not estimate or retain token usage, and it does not trim context. Normal models receive full history; an optional `history_mode: latest_only` sends only the new message and `session_id` for an upstream agent that owns its own session context.

## Quick start

Prerequisites:

- Docker and Docker Compose
- An OpenAI-compatible API endpoint
- An OIDC provider for normal use

Create a directory with `config/`, copy the example configuration files from this repository, and copy `.env.example` to `.env`. At minimum, set:

```dotenv
POSTGRES_PASSWORD=use-a-long-random-password
OPENAI_BASE_URL=http://host.docker.internal:4000/v1
OPENAI_API_KEY=
```

Then start the stack:

```bash
docker compose up -d
docker compose logs -f chat
```

Open <http://localhost:3000>. Configure OIDC in `config/config.yaml` before normal use.

The checked-in Compose file does not enable local authentication by default. For a temporary test-only login, set `LOCAL_AUTH=true` in `.env` and restart the stack. The credentials are fixed at `admin` / `admin`; do not enable this on an exposed deployment.

## Configuration

`config/config.yaml` contains deployment settings:

```yaml
app:
  name: "Chat"
  base_url: "http://localhost:3000"

openai:
  base_url: "${OPENAI_BASE_URL}"
  api_key: "${OPENAI_API_KEY}"

oidc:
  issuer: "https://auth.example.com"
  client_id: "chat"
  client_secret: "${OIDC_CLIENT_SECRET}"
  scopes: ["openid", "profile", "email", "groups"]

rbac:
  group_claim: "groups"
  mappings:
    - oidc_group: "admins"
      role: admin
  default_role: user

rate_limits:
  requests_per_minute: 120
  requests_per_hour: 1000
  concurrent_streams: 4

storage:
  # Per-user upload quota; use values such as "10G". 0 means unlimited.
  quota: "10G"

conversation:
  auto_title: true
  auto_title_model: "qwen3.5-0.8b"
```

`storage.quota` is a per-user quota for uploaded file data plus extracted text, derived images, and file metadata. Values use binary units, so `10G` means 10 GiB. `"0"` disables the quota. Uploads exceeding the quota are rejected with HTTP 507.

Remove or leave `oidc` unconfigured only when using the explicitly enabled test account. Normal deployments should configure OIDC and keep `LOCAL_AUTH` unset.

`config/models.yaml` controls display names, role visibility, and the relay contract:

```yaml
models:
  - id: "qwen3.5-0.8b"
    display_name: "Qwen 3.5 0.8B"
    allowed_roles: [admin, user]

  - id: "external-agent"
    display_name: "External agent"
    allowed_roles: [admin, user]
    history_mode: latest_only
```

Models not listed in this file default to admin-only. `history_mode` is either `full` (the default) or `latest_only`.

`prompts.yaml`, `presets.yaml`, and `automations.yaml` contain optional deployment-seeded definitions. They are read-only deployment configuration and are reconciled on startup.

## Security model

- OIDC ID tokens are verified against the issuer, audience, and provider JWKS.
- Roles are resolved from OIDC group claims; there are no local users or role overrides.
- The most recently resolved role is stored with the user so scheduled automations do not depend on an active session. IdP role changes take effect for background jobs after the user's next successful login.
- The local test account is disabled unless `LOCAL_AUTH` is explicitly enabled.
- Mutating API requests require same-origin checks and the application request header.
- Sessions are `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS.
- Upload ownership is checked on every access, and archive extraction has size and derivative caps.
- Markdown is sanitized before rendering, and responses include browser security headers.

## Development

```bash
cd frontend && npm ci && npm run check && npm run build
cd ../server && npm ci && npx tsc --noEmit
```

The server bundles as an ES module for Node.js 24+:

```bash
node_modules/.bin/esbuild src/index.ts \
  --bundle --platform=node --target=node24 --packages=external \
  --format=esm --outfile=dist/index.js
```

## Data and upgrades

PostgreSQL is the only supported application database. The schema is created forward-only on startup. This overhaul intentionally does not migrate or preserve the previous SQLite database; back up any data you want before switching deployments.
