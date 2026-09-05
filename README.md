# LLM Chat Frontend

A self-hosted chat application built with Svelte 5, a Hono server running on Node.js 26, and PostgreSQL. It connects to an OpenAI-compatible API for inference; it does not run models, tools, embeddings, RAG, or agent loops locally.

## Features

- Streaming chat with cancellation, regeneration, editing, forking, copying, and deletion.
- Durable chat generations that continue after browser disconnects and restart safely after an application restart.
- File attachments for common images, documents, spreadsheets, and text formats.
- Conversation search, folders, drag-and-drop, pinning, and inline folder creation.
- Personal prompts and model presets plus deployment-seeded shared definitions.
- Personal scheduled automations with manual runs and run history, subscriptions to shared automations, and automatic conversation titles.
- Durable automation and title jobs that recover after worker restarts.
- OIDC SSO with two roles (`admin`, `user`).
- One fixed local `admin`/`admin` account can be explicitly enabled for testing only.

## Architecture

The web process is stateless. PostgreSQL stores conversations, messages, identities, sessions, preferences, uploads, rate-limit counters, generation jobs, automation runs and delivery records, and title jobs. Any replica can handle any request. In-process maps, timers, and HTTP streams are only transient worker coordination; expired leases let another replica reclaim unfinished work.

Uploaded bytes and extracted derivatives are stored in PostgreSQL, so the application container has no required local data volume. The bundled PostgreSQL service persists data in the `postgres-data` volume. YAML files hold deployment settings, model rules, and shared definitions; shared definitions are reconciled into PostgreSQL at startup and on configuration reload. The Admin UI provides read-only lists of prompts and automations; configuration is edited on disk.

Sessions use random opaque bearer tokens. Only a SHA-256 token hash is stored in PostgreSQL, with expiry and revocation checked on every request. No signing secret is placed in configuration or generated per instance.

The relay builds history from the canonical conversation in PostgreSQL. It does not estimate or retain token usage, and it does not trim context. Normal models receive full history; an optional `history_mode: latest_only` sends the current system prompt, if set, and the latest user message, with the conversation ID as `session_id` for an upstream agent that owns its own session context.

## Quick start

Prerequisites:

- Docker and Docker Compose
- An OpenAI-compatible API endpoint reachable from the application container, with `/models` and `/chat/completions` support
- An OIDC provider for normal use, or the explicitly enabled local test account

Run these commands from a checkout of this repository. Compose builds the image from the local Dockerfile and mounts the checked-in `config/` directory.

```bash
cp .env.example .env
```

Set the database password and upstream URL in `.env` (replace the example endpoint with your own):

```dotenv
POSTGRES_PASSWORD=use-a-long-random-password
OPENAI_BASE_URL=https://inference.example.com/v1
OPENAI_API_KEY=
```

Edit [config/config.yaml](config/config.yaml) before starting:

- Change `openai.base_url` to `"${OPENAI_BASE_URL}"`. The checked-in file currently hardcodes `http://127.0.0.1:1234/v1`, so setting `.env` alone does not change it. Inside the container, `127.0.0.1` refers to the application container itself.
- Set `app.base_url` to the browser-facing origin, such as `http://localhost:3000` or your HTTPS deployment URL.
- Replace the example OIDC issuer and client ID, set `oidc.client_secret` to `"${OIDC_CLIENT_SECRET}"`, and add `OIDC_CLIENT_SECRET` to `.env`. Register `<app.base_url>/api/auth/callback` as the provider's redirect URI. Configure the group claim and scopes needed by your provider.
- For a temporary local test instead, set `LOCAL_AUTH=true` in `.env`; you can remove the `oidc` block. The fixed credentials are `admin` / `admin`. Keep this account disabled on exposed deployments.

Update [config/models.yaml](config/models.yaml) with IDs offered by your upstream and the roles allowed to use them. Also update `conversation.auto_title_model` and the model IDs in presets and automations, or disable automatic titles and empty any unused definitions.

Start the stack:

```bash
docker compose up -d --build
docker compose logs -f chat
```

Open <http://localhost:3000> for the default local deployment. The `/health` endpoint reports whether the web process is running or shutting down; it does not probe PostgreSQL or the upstream API.

After changing `.env`, run `docker compose up -d` to recreate containers with the new environment. A plain `docker compose restart` does not apply environment changes. For YAML-only changes, use the reload command below.

## Configuration

All five files must be present when `config/` is mounted read-only, as it is in Compose:

| File | Purpose |
| --- | --- |
| [config.yaml](config/config.yaml) | Application URL, upstream, authentication, rate limits, storage, and generation settings |
| [models.yaml](config/models.yaml) | Model display names, role visibility, and history mode |
| [prompts.yaml](config/prompts.yaml) | Shared system prompts |
| [presets.yaml](config/presets.yaml) | Shared model and system-prompt combinations |
| [automations.yaml](config/automations.yaml) | Shared scheduled prompts |

Unused definition files can contain `prompts: []`, `presets: []`, or `automations: []`. A writable configuration directory is scaffolded with defaults when files are missing; missing files in a read-only directory cause startup to fail.

String values support `${ENV_VAR}` substitution; an unset variable becomes an empty string. Environment variables do not override literal YAML values. The following example uses a 10 GiB quota and environment-based upstream and OIDC credentials:

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
  # Limits apply to each generation attempt.
  generation_max_duration_ms: 1800000
  generation_idle_timeout_ms: 120000
  # Maximum attempts for ordinary upstream failures. Worker-loss recovery does
  # not consume this budget.
  generation_max_attempts: 3
```

Chat requests are committed as durable PostgreSQL jobs before the server sends
the `accepted` event. Closing the tab, navigating away, losing the client
connection, or logging out only detaches live streaming. The response continues
in the background. If the application process disappears, another worker claims
the expired job and restarts the generation from the beginning; partial text
from the abandoned attempt is replaced so it cannot be duplicated. The Stop
button is different: it records a durable cancellation and aborts the upstream
request.

`storage.quota` is a per-user quota for uploaded file data plus extracted text, derived images, and file metadata. Values use binary units, so `10G` means 10 GiB. The checked-in configuration uses `"500M"`; `"0"` disables the quota, which is also the schema default if `storage` is omitted. Uploads exceeding the quota are rejected with HTTP 507.

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

The server discovers models from the upstream `/models` endpoint and applies YAML settings to matching IDs. Discovered models not listed in YAML default to admin-only. A successful discovery response determines the available IDs; adding a model to YAML does not make the upstream serve it. If discovery fails, the server falls back to its cached list or the YAML list. Model discovery is cached for 60 seconds. `history_mode` is either `full` (the default) or `latest_only`.

Shared prompts, presets, and automations are matched by name during reconciliation. Changes update the shared definition, and removing a definition from YAML soft-deletes it. Personal definitions are managed in the UI and are not overwritten by YAML reconciliation.

Reload YAML without restarting the application:

```bash
docker compose kill -s SIGHUP chat
docker compose logs --tail=50 chat
```

The server validates and reconciles the candidate configuration before replacing the active configuration, then invalidates model and OIDC discovery caches. Failed reloads retain the previous configuration and are logged. In a replicated deployment, distribute the same YAML files and reload every application process.

## Attachments and automations

Images (JPEG, PNG, GIF, WebP) can be up to 20 MiB each; supported documents and text files can be up to 50 MiB each. Documents include PDF, DOCX, ODT, EPUB, XLSX, and ODS, alongside plain text, Markdown, CSV/TSV, HTML, JSON, YAML, and XML. Legacy XLS uploads are accepted, but their contents are not extracted; convert them to XLSX first.

PDF pages are rendered as images. DOCX, ODT, and EPUB uploads provide extracted text and embedded images; spreadsheets provide extracted text. Extraction has size and image/page caps. Use a vision-capable upstream model for images and PDFs.

Automations use a positive integer interval in `hours`, `days`, or `weeks`. Users can create and enable personal automations, run them manually, and inspect their latest 50 runs. Shared automations come from YAML and require users to opt in through subscriptions. Successful runs create conversations for the owner or eligible subscribers. The scheduler checks for due work every 30 seconds and schedules the next run relative to the current time. Automations call the upstream API with their configured prompts; any browsing or tools must be supplied by the upstream.

## Security model

- OIDC ID tokens are verified against the issuer, audience, and provider JWKS.
- OIDC roles are resolved from group claims; there is no local user-management or role-override UI.
- The most recently resolved role is stored with the user so scheduled automations do not depend on an active session. IdP role changes take effect for background jobs after the user's next successful login.
- The local test account is disabled unless `LOCAL_AUTH` is explicitly enabled.
- Mutating API requests require same-origin checks and the application request header.
- Session cookies are `HttpOnly` and `SameSite=Lax`; `Secure` is enabled when `app.base_url` starts with `https://`.
- Upload ownership is checked on every access, and archive extraction has size and derivative caps.
- Markdown is sanitized before rendering, and responses include browser security headers.

## Development

Use Node.js 26.x (both packages require `>=26.0.0 <27`) and a PostgreSQL database. CI and Compose use PostgreSQL 17. Install dependencies and run the checks from the repository root:

```bash
npm --prefix frontend ci
npm --prefix server ci
npm --prefix frontend test
npm --prefix frontend run check
npm --prefix frontend run build
npm --prefix server run typecheck
npm --prefix server test
```

Configure `.env` and YAML as described above, using an upstream URL reachable from your host. Start the server from the repository root with a connection string for your development database:

```bash
cd server
CONFIG_DIR=../config STATIC_DIR=../frontend/dist \
  DATABASE_URL=postgres://user:password@localhost:5432/llm_gui \
  node --env-file=../.env --watch src/index.ts
```

This serves the built frontend at <http://localhost:3000>. The server runs TypeScript directly; `npm run build` in `server/` only typechecks. The bundled Compose database does not publish a host port, so host development needs a separate accessible database or a local Compose override that publishes PostgreSQL.

For frontend hot reload, run `npm --prefix frontend run dev` in another terminal from the repository root. Vite proxies `/api`, `/uploads`, and `/health` to `http://localhost:3000`. When testing OIDC through Vite, set `app.base_url` to the Vite origin (normally `http://localhost:5173`) and register `http://localhost:5173/api/auth/callback` with the provider.

The durable worker integration suite requires a separate, disposable PostgreSQL database. It fails when `GENERATION_TEST_DATABASE_URL` is missing. Run it from the repository root:

```bash
GENERATION_TEST_DATABASE_URL=postgres://user:password@localhost:5432/llm_gui_test \
  npm --prefix server run test:integration
```

Server environment settings:

| Variable | Default / purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection string; supplied by Compose |
| `CONFIG_DIR` | `/app/config` |
| `STATIC_DIR` | `./static`, relative to the server's working directory |
| `PORT` | `3000` |
| `DATABASE_POOL_MAX` | `20` connections per process |
| `DATABASE_SSL` | Set to `true` to enable database TLS |
| `DATABASE_SSL_VERIFY` | Certificate verification is enabled unless set to `false` |
| `LOCAL_AUTH` | Disabled by default; `true`, `1`, or `yes` enables the fixed test account |

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OIDC_CLIENT_SECRET` are consumed through YAML substitution. Compose reads `.env`; direct Node invocations need `--env-file` or exported variables.

## Continuous integration

Both workflows run server typechecking, server and frontend unit tests, the PostgreSQL integration suite, Svelte diagnostics, and a frontend build before building the production image:

- [GitHub Actions](.github/workflows/docker.yml) runs on pushes to `main` and publishes `latest` and commit-SHA tags to `ghcr.io/lixa9/llm-gui` using `GITHUB_TOKEN`.
- [Gitea Actions](.gitea/workflows/docker.yml) runs on pushes and pull requests and also audits production dependencies. Pushes to `main` publish `latest` and commit-SHA tags to `git.control.lan/<repository>` using the repository secret `PACKAGE`.

## Data and upgrades

PostgreSQL is the only supported application database. Schema creation and forward-only updates run on startup. Back up PostgreSQL and deployment configuration before upgrading; uploads are part of the database backup. The current application does not migrate the previous SQLite database. The Compose `postgres-data` volume holds persistent application data; `docker compose down -v` deletes it.
