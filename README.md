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

The relay builds full history from the canonical conversation in PostgreSQL for every backend, including custom agents. Plain user and assistant text is sent as strings; no message IDs, timestamps, manifests, or extra instructions are injected. A system prompt is included only when configured. Attachments use standard image/file inputs or extracted text with readable filename and section headers. Interrupted replies remain visible but are excluded from replay. The server retains provider-reported numeric token usage in diagnostics; it does not estimate tokens or silently trim context. See the [conversation transport specification](docs/conversation-transport.md).

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

Update [config/models.yaml](config/models.yaml) with IDs offered by your upstream and the roles allowed to use them. Automatic titles are disabled by default; to enable them, explicitly configure `conversation.auto_title_model` and set `conversation.auto_title: true`. Also update the model IDs in presets and automations, or empty any unused definitions.

Start the stack:

```bash
docker compose up -d --build
docker compose logs -f chat
```

Open <http://localhost:3000> for the default local deployment. The `/health` endpoint reports whether the web process is running or shutting down; it does not probe PostgreSQL or the upstream API.

Health responses are never compressed. See [performance notes](docs/performance.md) for benchmarks, diagnostics, and the transport-level changes introduced by performance optimizations.

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
  # Optional deployment branding:
  # tagline: "Your team assistant"
  # logo_url: "/logo.svg"
  # accent_color: "#7566dd"
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
  global_workers: 8
  workers_per_owner: 2
  max_queued_jobs: 200

attachments:
  max_request_bytes: 33554432
  max_images: 100
  max_files: 50
  max_text_chars: 500000
  processing_workers: 2

storage:
  # Per-user upload quota; use values such as "10G". 0 means unlimited.
  quota: "10G"

conversation:
  max_output_bytes: 1000000
  max_frame_bytes: 1000000
  auto_title: false
  # Set a model ID served by your upstream before enabling automatic titles.
  # auto_title_model: "your-title-model-id"
  auto_title_prompt: >-
    Return a 4-6 word title for this conversation. No punctuation, no quotes.
  # Limits apply to each generation attempt.
  generation_max_duration_ms: 1800000
  generation_idle_timeout_ms: 120000
  # Maximum attempts for ordinary upstream failures. Worker-loss recovery does
  # not consume this budget.
  generation_max_attempts: 3
```

Automatic titles run after the first successfully completed chat response. There is no default title model and no fallback to the chat model. Enabling `auto_title` without a nonempty `auto_title_model` fails configuration validation at startup; an invalid reload retains the previous configuration. With a nonempty `models.yaml` registry, the title model must be listed there. Listing a model does not install it or make the upstream serve it: if the provider rejects the title request, the title job records the error without failing the completed chat response or switching models.

`auto_title_prompt` is the title request's system prompt, separate from the chat's system prompt. It defaults to the instructions shown above and accepts up to 10,000 characters; blank values are rejected. The first user message and assistant response form the title context, limited to 2,000 characters. Title requests allow 20 output tokens, and titles are limited to 80 characters. Model and prompt are snapshotted when the chat request is accepted, so configuration reloads do not alter queued title jobs or retries. Older jobs without a saved title system prompt retain the previous default instructions; older generations without a title model fail their title job explicitly. Manually renamed chats are never overwritten.

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
    capabilities:
      vision: true
      native_pdf: false
      image_detail: auto
      stream_usage: false
      max_text_chars: 500000

  - id: "external-agent"
    display_name: "External agent"
    allowed_roles: [admin, user]
```

The server discovers models from the upstream `/models` endpoint and applies YAML settings to matching IDs. Discovered models not listed in YAML default to admin-only. A successful discovery response determines the available IDs; adding a model to YAML does not make the upstream serve it. If discovery fails, the server falls back to its cached list or the YAML list. Model discovery is cached for 60 seconds. Every backend receives full history. Remove `history_mode` from model configuration: `latest_only` is rejected; legacy `full` is accepted and normalized away. External agents must treat the supplied transcript as authoritative rather than append it to their own conversation history.

Shared prompts, presets, and automations are matched by name during reconciliation. Changes update the shared definition, and removing a definition from YAML soft-deletes it. Personal definitions are managed in the UI and are not overwritten by YAML reconciliation.

Reload YAML without restarting the application:

```bash
docker compose kill -s SIGHUP chat
docker compose logs --tail=50 chat
```

The server validates and reconciles the candidate configuration before replacing the active configuration, then invalidates model and OIDC discovery caches. Failed reloads retain the previous configuration and are logged. Replicas must share the same YAML configuration mount; each checks for changes every five seconds. PostgreSQL records the active revision and fences API calls and job claims on stale replicas. SIGHUP remains available for immediate reload. Queued work is pinned to its original endpoint and credential revision; changing either fails the job with a resubmit message. Credentials are never stored in job snapshots. Models, prompts, presets, automations, duplicate identifiers, and limits are validated before reconciliation. With a nonempty model registry, preset and automation model references and role access must match it.

## Attachments and automations

Images can be up to 20 MiB each; supported documents, text, and archives can be up to 50 MiB each. The composer reads its accepted formats from the server registry.

| Family | Supported formats |
| --- | --- |
| Images | JPEG, PNG, GIF, WebP, HEIC/HEIF, BMP, TIFF, SVG |
| Documents | PDF, DOC/DOCX, ODT, RTF, PPT/PPTX, ODP, EPUB |
| Spreadsheets | XLS/XLSX, ODS |
| Text/data | TXT/TEXT, MD/MARKDOWN, HTML/HTM, CSV/TSV, JSON, JSONL/NDJSON, YAML/YML, XML |
| Source/config/logs | PY, JS/MJS/CJS, TS/TSX/JSX, JAVA, C/H/CPP/HPP, CS, GO, RS, SH/BASH, SQL, CSS, TOML, INI, CONF, PROPERTIES, LOG, DIFF, PATCH, Dockerfile, Makefile, .env, .gitignore |
| Archives/email | ZIP, TAR, TAR.GZ/TGZ, GZ, EML |

PDF fallback includes extracted text and page images. Word and presentation files use an isolated LibreOffice process to preserve layout through PDF conversion; PPTX also includes speaker notes. XLS is converted to XLSX before reading cells. Images are normalized to supported PNG inputs, with orientation applied. SVG rejects active/external content. GIF includes its first frame; TIFF includes up to 20 frames. Spreadsheets preserve cell values, cached formula results, common dates/percentages/booleans, and CSV quoting; formulas are not evaluated.

Archive entries are read in memory with path, expanded-size, count, text, and image limits. Up to 50 supported files and 20 images are included per collection; nested archives/email containers are omitted. EML includes headers, its text body, and supported attachments. Coverage controls on sent attachments show included/omitted content, and originals remain downloadable. Failed processing returns HTTP 422 instead of a successful placeholder.

Set `capabilities.vision: true` only for models/routes that accept image inputs. Native PDF requires both `vision: true` and `native_pdf: true`; this sends the original through Chat Completions `file.file_data`. New PDF uploads are normalized independently of the selected model, so the same upload can be used with native or rendered PDF input. Older native-only uploads still require reuploading to use a fallback model. Capability defaults are conservative (`false`). Private application URLs never go to the provider. The complete replayed request is bounded by configured bytes, image/file counts, and text characters. Character budgets are operational limits, not exact token estimates.

Draft text and ready attachments are stored privately in PostgreSQL per conversation (including a new-conversation draft), with serialized autosaves. Accepted messages clear their drafts; rejected messages retain them. Drafts and running jobs pin their uploads against orphan cleanup. Folder expansion preferences persist per user. Branding uses the optional `app` fields above; logo paths must be same-origin assets served by the deployment.

See the [conversation transport specification](docs/conversation-transport.md) and [implementation notes](docs/implementation-notes.md) for issue mapping, limits, upgrade behavior, and validation.

Automations use a positive integer interval in `hours`, `days`, or `weeks`. Users can create and enable personal automations, run them manually, and inspect their latest 50 runs. Shared automations come from YAML and require users to opt in through subscriptions. Successful runs create conversations for the owner or eligible subscribers and retain their effective system prompt. Unsubscribe, visibility/role narrowing, disabling, or deletion prevents pending deliveries. Only one queued/running job is allowed per automation; manual triggers use user rate limits, and all generation types share database-backed worker and queue admission. The scheduler checks for due work every 30 seconds and schedules the next run relative to the current time. Automations call the upstream API with their configured prompts; any browsing or tools must be supplied by the upstream.

## Security model

- OIDC ID tokens are verified against the issuer, audience, and provider JWKS.
- OIDC roles are resolved from group claims; there is no local user-management or role-override UI.
- Stored OIDC groups are reevaluated against current RBAC for every authenticated request. IdP group changes are observed on the next login; scheduled automation owners/recipients require an observed role within 24 hours. Existing OIDC sessions from older versions without stored groups require a new login.
- The local test account is disabled unless `LOCAL_AUTH` is explicitly enabled.
- Mutating API requests require same-origin checks and the application request header.
- Session cookies are `HttpOnly` and `SameSite=Lax`; `Secure` is enabled when `app.base_url` starts with `https://`.
- Upload ownership is checked on every access, and archive extraction has size and derivative caps.
- Markdown is sanitized before rendering, and responses include browser security headers.

## Development

Document/image conversion also requires LibreOffice Writer/Impress/Calc, ImageMagick with HEIC decoding, DejaVu fonts, and `prlimit` (util-linux); the supplied Dockerfile installs them. Run `npm --prefix server run test:conversions` with these tools installed to exercise actual conversion fixtures.

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
