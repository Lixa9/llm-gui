# LLM Chat Frontend — Design Document

> This file is a design document, not a usage guide. It describes the architecture, data model, configuration, and implementation decisions behind this project.

## Context

Existing LLM frontends (OpenWebUI, LibreChat, AnythingLLM, LobeChat) bundle too many services, have cloud dependencies, or are architecturally bloated. The goal is a self-hosted frontend that is a **pure relay + display layer**: it does no inference, no embeddings, no RAG, no tool execution. All intelligence — including tool calling — lives upstream in LiteLLM. The app adds: conversation management, OIDC auth with RBAC, automations, and rendering of tool call events that appear in the stream. Config is code (YAML). Nothing AI-specific runs inside this container.

---

## Guiding Principles

- **No AI in the container**: no embeddings, no vector DB, no model downloads, no tool execution. LiteLLM is always an external service and handles everything intelligence-related, including MCP tool calling.
- **Single container for the app**: Svelte SPA + lightweight server in one image. SQLite in a mounted volume (no separate DB container needed, but one could be added later).
- **OpenAI API only**: one API surface. LiteLLM virtualizes all upstream providers and manages tool schemas and execution upstream.
- **Tool calls are display-only**: when LiteLLM returns tool call events in the stream, the frontend renders them as collapsed blocks. Users see what happened, but tool configuration is an admin/LiteLLM concern.
- **Config is code for infra, DB for user content**: YAML for auth, model display hints, RBAC, and system-level automations. User-created content (conversations, personal prompts, personal automations) lives in SQLite.
- **OIDC-first auth**: delegate identity to Authelia (or any OIDC provider). No home-grown user management. A single local admin account (env-var credentials) is available as a fallback.
- **LiteLLM is optional**: the server starts and all conversation management features work without a LiteLLM endpoint configured. Sending a message simply returns an error; no crash or degraded UI state.

---

## Architecture

```
Browser (Svelte 5 SPA)
│
│  HTTPS  (user's reverse proxy: nginx / Caddy / Traefik)
│
App Container (Bun + TypeScript server)
├── Static file server        (compiled Svelte build)
├── OIDC middleware            (Authorization Code + PKCE → Authelia)
├── Config loader              (reads YAML files on startup)
├── Conversation API           (SQLite via Bun's built-in driver)
├── OpenAI relay               (transparent SSE proxy to LiteLLM; parses stream for storage + display events)
├── Automation scheduler       (cron + pipeline runner, built with Bun timers)
└── SQLite volume              (/data/chat.db)

LiteLLM proxy  ← external container, user's existing setup
                 (owns tool schemas, MCP server connections, RAG, model routing)
```

**Why Bun?** Compiled TypeScript, built-in SQLite, extremely low RAM, fast startup, native streaming HTTP. Types are shared between server and Svelte frontend. No Python runtime needed in the container.

---

## Frontend: Svelte 5 + TypeScript

**Why Svelte**: compiles away the framework — minimal JS bundle, near-zero runtime overhead, no virtual DOM. Ideal for a UI that is mostly streaming text display.

### Views

| View | Purpose |
|---|---|
| **Chat** | Streaming message display with stop button; tool call accordion (collapsed by default); per-message actions (edit, regenerate, copy to clipboard, delete, fork from here); image attachment input; model / preset picker; prompt picker |
| **Conversations** | Sidebar with folder tree + full-text search across message content; per-conversation actions: pin, duplicate, move to folder, delete, rename; forked conversations shown with origin link |
| **Prompt Library** | Personal named system prompts (create, edit, delete) + read-only admin-seeded prompts from `prompts.yaml`; all displayed in cleartext; select when starting a conversation |
| **Model Presets** | Create/edit/delete personal model presets (base model + system prompt + display name); selecting a preset in the composer pre-fills the model and system prompt for that conversation |
| **Automations** | Create/edit/trigger personal scheduled prompts and pipelines; view run history; full definition shown in cleartext |
| **Admin** | View all users (OIDC-sourced), manage local role overrides, view all users' prompts and automations (read-only), view config YAML (read-only) |

### Message Actions

Each message (user and assistant) has a context menu with:
- **Edit**: inline edit of the message text. Behaviour differs by role:
  - *User message*: saves the new content, then automatically regenerates the subsequent assistant response (equivalent to edit + regenerate in one action). All messages after this user message are replaced.
  - *Assistant message*: saves the new content directly to SQLite with no LLM call. The message is marked with `edited_at` in the DB; a small "edited" indicator is shown in the UI.
- **Copy**: copies the message text to the clipboard; available on both user and assistant messages
- **Regenerate**: resend the conversation history up to (not including) this message; the response replaces this message in the current branch (assistant messages only)
- **Delete**: remove this message and all subsequent messages in the conversation
- **Fork from here**: create a new conversation containing all messages up to and including this one; the fork appears in the sidebar with a link back to the parent

### Image Input

The message composer accepts image attachments (drag-and-drop or file picker). Images are encoded as base64 `image_url` content parts and sent to LiteLLM as a multipart message. The UI displays a thumbnail inline. Whether the model supports images is a LiteLLM concern — the frontend passes the content structure through unchanged.

### Tool Call Display

Tool calls are not user-configurable — they are whatever LiteLLM decides to use. When the stream contains tool call events, the UI renders them as collapsed blocks:

```
▶ web_search  {"query": "Svelte 5 runes"}          ← collapsed by default (click to expand)
  Result: "Svelte 5 introduced runes..."
```

Default show/hide can be set per model in `models.yaml` (e.g., hide for known agent models where tool chatter is noisy). Users cannot add or remove tools — that is LiteLLM configuration.

---

## Server: Bun + TypeScript

### Modules

| Module | Responsibility |
|---|---|
| `config.ts` | Loads and validates all YAML files at startup; detects read-only mounts; hot-reloads on SIGHUP |
| `auth.ts` | OIDC Authorization Code + PKCE, session JWT (httpOnly cookie), RBAC enforcement |
| `relay.ts` | Transparent SSE proxy to LiteLLM; parses stream to extract tool call events for storage and display; emits `title` and `done` SSE events on finish |
| `conversations.ts` | CRUD: conversations and messages in SQLite |
| `automations.ts` | Cron scheduler + sequential pipeline runner using the relay |
| `models.ts` | Fetches available models from LiteLLM `/models` endpoint; caches with TTL |
| `logger.ts` | Structured JSON logging to stdout (request, user sub, model, tokens, latency, errors) |

### Relay Behaviour

```
POST /api/chat  (from Svelte frontend, carries an AbortSignal from the browser)
  │
  ├─ rate-limit check (per user, per config.yaml limits — reject 429 if exceeded)
  ├─ load conversation history from SQLite
  │    optionally truncated at a message ID (for regenerate)
  ├─ forward request to LiteLLM (no modification to tool schemas or model params)
  │    AbortSignal is propagated to the LiteLLM fetch
  ├─ stream LiteLLM response → SSE → browser
  │    for each chunk:
  │      if chunk contains tool_call delta  → emit display event to browser
  │      if chunk contains tool_result      → emit display event to browser
  │      always stream tokens to browser
  │    if client disconnects (stop button):
  │      AbortSignal fires → LiteLLM fetch is aborted → agent/stream stops
  │      partial response saved to SQLite with status "aborted"
  └─ on normal finish:
       save full conversation (messages + tool call records) to SQLite
       emit SSE event {"type": "done"}  → browser plays completion sound
       if first exchange and auto_title enabled:
         call LiteLLM (short, non-streaming) for title
         emit SSE event {"type": "title", "title": "..."}  → sidebar updates
```

**Stop generation**: no special OpenAI endpoint needed. The browser's `AbortController` closes the SSE connection; the Bun server detects the disconnect via `request.signal` and cancels the upstream fetch. LiteLLM receives the disconnection and halts the agent. This works for full agentic loops because LiteLLM owns the loop — one abort kills the whole chain.

**Context window sliding window**: before forwarding, the relay trims the message list (oldest first, preserving the system prompt) until the estimated token count fits within `context_window_tokens - context_window_reserve`. Token estimation is character-based (characters ÷ 4), not a real tokenizer — fast and good enough for truncation decisions. Trimmed messages are not deleted from SQLite; they just aren't sent. If even a single message exceeds the budget, it is sent anyway and LiteLLM returns an error that the UI surfaces to the user.

The relay is otherwise a transparent passthrough. LiteLLM owns the entire tool calling loop (schema injection, MCP execution, re-submission). The frontend server only parses the stream to: (a) persist the conversation, and (b) emit structured display events so the UI can render tool call accordions.

---

## Configuration: YAML Files

All files are mounted into the container. **YAML is always authoritative**: on every startup the server reconciles system-owned DB rows (`owner_sub = null`) against the YAML files — inserting new entries, updating changed ones, and soft-deleting removed ones (rows are marked `deleted_at` rather than hard-deleted to preserve referential integrity with runs and conversations).

**Admin UI edits write back to the YAML files**: when an admin edits a system-seeded prompt or automation through the admin UI, the server updates both the DB row and rewrites the corresponding YAML file in place. This keeps the mounted YAML file as the source of truth on disk. The YAML file must be on a writable mount for this to work (document in deployment notes).

### `config.yaml` — top-level app settings

```yaml
app:
  name: "Chat"
  base_url: "https://chat.example.com"   # defaults to http://localhost:3000
  secret_key: "${SECRET_KEY}"             # JWT signing; auto-generated (ephemeral) if not set

litellm:
  base_url: "http://litellm:4000"   # omit entire block to run without AI
  # api_key: "${LITELLM_API_KEY}"   # optional; omit if LiteLLM requires no auth

database:
  path: "/data/chat.db"

# Omit the oidc block entirely to disable SSO login (local admin only)
oidc:
  issuer: "https://authelia.example.com"
  client_id: "chat"
  client_secret: "${OIDC_CLIENT_SECRET}"
  scopes: ["openid", "profile", "email", "groups"]

rbac:
  group_claim: "groups"          # OIDC claim that contains group list
  mappings:
    - oidc_group: "admins"
      role: admin
    - oidc_group: "users"
      role: user
  default_role: user             # for OIDC users with no matching group

rate_limits:
  # Applied per authenticated user; 0 = unlimited
  requests_per_minute: 60        # total chat requests per minute
  requests_per_hour: 300         # total chat requests per hour (catches start/stop abuse)
  concurrent_streams: 2          # max simultaneous streaming requests per user

conversation:
  auto_title: true               # generate title via LiteLLM after first exchange
  auto_title_model: "gpt-4o-mini"  # cheap model for titling; falls back to first-50-chars if unset
  context_window_tokens: 100000  # max tokens sent to LiteLLM per request (sliding window)
  context_window_reserve: 1000   # tokens reserved for the response
```

### `models.yaml` — per-model display overrides

Models are discovered dynamically from LiteLLM's `/models` endpoint. This file only adds display metadata and UI behavior hints for known models.

**Default for undeclared models (secure by default):** any model that appears in LiteLLM but has no entry in `models.yaml` is treated as `allowed_roles: [admin]` and `show_tool_calls: true`. This is the "raw and secure" mode — new models are never accidentally exposed to regular users.

```yaml
models:
  - id: "gpt-4o"
    display_name: "GPT-4o"
    show_tool_calls: true
    allowed_roles: [admin, user]   # explicitly grant to users

  - id: "claude-opus-4-7"
    display_name: "Claude Opus"
    show_tool_calls: false         # suppress for heavy agent use (noisy)
    allowed_roles: [admin, user]

  - id: "gpt-4o-mini"
    display_name: "GPT-4o Mini"
    show_tool_calls: true
    allowed_roles: [admin, user]
```

No tool schemas here. Tools are LiteLLM's concern.

### `prompts.yaml` — admin-seeded system prompts

Prompts defined here appear in every user's Prompt Library (within their role) alongside their personal prompts. They are read-only for users; only an admin editing the YAML can change them.

```yaml
prompts:
  - name: "Concise assistant"
    content: "You are a helpful assistant. Keep responses short and to the point."
    visible_to: [admin, user]

  - name: "Code reviewer"
    content: "You are an expert code reviewer. Focus on correctness, security, and clarity."
    visible_to: [admin, user]

  - name: "Raw debug mode"
    content: "Respond with no formatting. Output raw information only."
    visible_to: [admin]
```

### `automations.yaml` — system-level automations (admin-seeded)

YAML defines automations that are created at server startup and owned by the system (not a specific user). They appear in the admin view and can optionally be visible to all users.

```yaml
automations:
  - name: daily_digest
    type: scheduled
    schedule: "0 8 * * 1-5"
    visible_to: admin              # only admins see this in the UI
    model: gpt-4o
    system_prompt: "You are a concise news summarizer."
    user_prompt: "Summarize the top tech news today."
    output: new_conversation
```

If a model configured in LiteLLM has tools attached (e.g., web search enabled for `gpt-4o`), those tools will fire naturally during automation runs — no explicit tool listing needed here. The pipeline steps just send messages; LiteLLM decides when to call tools.

**Pipeline execution context**: each pipeline run creates exactly one new conversation. Step outputs are appended to that conversation as user/assistant message pairs, so each subsequent step receives the full accumulated context. Multiple automation runs are always separate conversations — they never share a conversation.

### User-created automations (DB-stored)

Users create personal automations in the UI. Same structure as YAML automations, stored in SQLite under the user's `sub`. Full automation definition (prompts, schedule, pipeline steps) is shown in cleartext in the UI — no obfuscation. Admins can view all users' automations in the admin panel (read-only).

---

## Authentication & RBAC

**Primary flow**: OIDC Authorization Code + PKCE → Authelia (or any OIDC provider) → session JWT stored in httpOnly Secure cookie.

**Local admin account** (opt-in): set `LOCAL_ADMIN_USERNAME` and `LOCAL_ADMIN_PASSWORD` environment variables to enable a single local account with hardcoded `admin` role. Both vars must be set; omitting either disables local auth entirely. Password accepts plain text or an argon2/bcrypt hash. The login page always shows the SSO button; the username/password form only appears when local auth is enabled. Local sessions skip the OIDC `end_session` redirect on logout.

**Roles**:

| Role | What they can do |
|---|---|
| `admin` | Chat with all models; own conversations, prompts, automations; **read all users' prompts and automations** in admin view; manage role overrides; view/edit YAML config |
| `user` | Chat with allowed models; own conversations, personal prompts, personal automations |

OIDC role assignment (precedence order):
1. **OIDC group claim → YAML mapping** — when the user's token contains at least one group that matches a `rbac.mappings` entry, that role wins. The first matching entry in the list is used.
2. **`role_override` in SQLite** — used only when the OIDC token contains no matching group claim. Admin can set per-user overrides in the admin view.
3. **`default_role` from `config.yaml`** — fallback when neither OIDC group mapping nor a local override applies.

---

## Data Model (SQLite)

Only user-generated data lives in the DB. All config is YAML.

| Table | Key columns |
|---|---|
| `users` | `sub` (OIDC subject), `email`, `role_override` (nullable), `created_at` |
| `user_preferences` | `user_sub`, `key`, `value` (text), `updated_at` — arbitrary per-user settings; known keys: `sound_enabled` (default `"true"`), `sound_volume` (default `"1.0"`), `default_model_id`, `default_system_prompt` (text, global default pre-filled in new conversations), `model_system_prompt:{model_id}` (per-model override, takes precedence over global default) |
| `conversation_folders` | `id`, `owner_sub`, `name`, `parent_id` (FK → self, nullable for root folders), `created_at` |
| `model_presets` | `id`, `owner_sub`, `name`, `base_model_id`, `system_prompt` (text), `created_at` |
| `conversations` | `id`, `owner_sub`, `title`, `title_auto` (bool), `model_id`, `system_prompt_id` (FK nullable — library prompt), `custom_system_prompt` (text nullable — one-off inline prompt; takes precedence over `system_prompt_id`), `folder_id` (FK → `conversation_folders`, nullable), `pinned` (bool, default false), `forked_from_id` (FK nullable), `forked_at_message_id` (FK nullable), `created_at` |
| `messages` | `id`, `conversation_id`, `role`, `content` (JSON multipart — text + image_url parts), `tool_calls` (JSON), `tool_results` (JSON), `model`, `tokens_in`, `tokens_out`, `status` (done/aborted), `timestamp`, `edited_at` (nullable — set when content is manually edited; triggers "edited" indicator in UI) |
| `messages_fts` | FTS5 virtual table over `messages.content`; kept in sync via SQLite triggers; search scoped to `owner_sub` via join |
| `system_prompts` | `id`, `owner_sub` (null = admin-seeded from YAML), `name`, `content` (plaintext), `visible_to` (JSON roles array, null = personal), `created_at`, `deleted_at` (nullable — soft-delete for YAML-removed entries) |
| `automations` | `id`, `owner_sub` (null = system/YAML-seeded), `name`, `type` (scheduled/pipeline), `definition` (JSON), `enabled`, `created_at`, `deleted_at` (nullable) |
| `automation_runs` | `id`, `automation_id`, `started_at`, `conversation_id`, `status`, `error` |

**Image storage**: images are not stored as base64 in SQLite. On upload, the server writes the file to `/data/uploads/[sha256].[ext]` and stores the path in the `content` JSON part (`{"type": "image_url", "image_url": {"url": "/uploads/[sha256].[ext]"}}`). The server serves `/uploads/*` as static files (auth-gated). This keeps SQLite lean.

**Forking**: when a user forks from message N, a new conversation row is inserted with `forked_from_id` and `forked_at_message_id` set. Messages up to N are copied into the new conversation (image paths are shared, not duplicated). The sidebar displays a "forked from [parent title]" indicator.

**Duplicate**: duplicating a conversation copies all messages into a new conversation row with no `forked_from_id` set (it is a standalone copy, not a fork). Title gets " (copy)" appended; `title_auto = false`.

**Folders**: `conversation_folders` supports arbitrary nesting via self-referential `parent_id`. The sidebar renders a collapsible folder tree. There is no enforced depth limit, but the UI renders at most ~4 levels before flattening. Moving a conversation sets `folder_id`; moving a folder re-parents it by updating `parent_id`.

**Conversation auto-naming**: after the first assistant response completes, the server makes a short non-streaming call to `auto_title_model` with the first exchange and asks for a 4–6 word title. The result is saved as `title` with `title_auto = true`. User edits set `title_auto = false` (preventing future auto-updates). If `auto_title` is disabled or the call fails, the title defaults to the first 50 characters of the first user message.

**Automation conversation naming**: the scheduler generates the title as `"[automation_name] — [Day abbrev] [D] [Mon abbrev] [YYYY], [HH:MM]"`, e.g. `"daily_digest — Mon 6 Mar 2026, 08:30"`. `title_auto = false` (no LLM rename for these).

---

## Docker

### Dockerfile (two-stage)

```dockerfile
# Stage 1: build Svelte frontend
FROM node:22-slim AS build
WORKDIR /app
COPY frontend/ .
RUN npm ci && npm run build

# Stage 2: Bun runtime
FROM oven/bun:1-slim
WORKDIR /app

COPY server/ .
COPY --from=build /app/dist ./static
RUN bun install --production

VOLUME ["/data"]
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
```

### docker-compose.yml (user's side, example)

```yaml
services:
  chat:
    image: ghcr.io/you/llm-frontend:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
      - ./config/config.yaml:/app/config/config.yaml
      - ./config/models.yaml:/app/config/models.yaml
      - ./config/prompts.yaml:/app/config/prompts.yaml
      - ./config/automations.yaml:/app/config/automations.yaml
    environment:
      SECRET_KEY: ${SECRET_KEY}           # Required for persistent sessions; auto-generated if unset
      # OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET}   # Only needed if oidc block is in config.yaml
      # LITELLM_API_KEY: ${LITELLM_API_KEY}         # Only needed if LiteLLM requires auth
      # LOCAL_ADMIN_USERNAME: admin                  # Optional local admin account
      # LOCAL_ADMIN_PASSWORD: ${LOCAL_ADMIN_PASSWORD}
```

---

## Security Defaults

| Default | Rationale |
|---|---|
| Undeclared models → `allowed_roles: [admin]` | New models from LiteLLM are never accidentally exposed to regular users. Must be explicitly granted in `models.yaml`. |
| Default OIDC role → `user` (configurable) | A user who authenticates but has no matching group claim gets the `user` role by default. Set `default_role: admin` only if the instance is single-user. |
| LiteLLM API key server-side only | The relay holds the key; the browser never receives it. No API key in any SSE event or response payload. |
| CORS: same-origin only | The server rejects cross-origin requests. No external site can call the API on behalf of a logged-in user. |
| Session cookie: `httpOnly`, `Secure`, `SameSite=Lax` | Prevents XSS token theft and CSRF. Local auth skips `Secure` flag in development only. |
| Admin view of conversations: metadata only | Admins see conversation titles, model, timestamp, and owner — but not message content. A `full_admin_read` flag in `config.yaml` unlocks content access (off by default). |
| `SECRET_KEY` auto-generates if unset | Server logs a warning and generates an ephemeral key; sessions don't survive restarts. Set `SECRET_KEY` in production to get persistent sessions. |
| SQLite file created as mode 600 | Volume should be mounted with restricted permissions. Documented in deployment notes. |
| Rate limiting | Per-user limits in `config.yaml`: `requests_per_minute`, `requests_per_hour`, `concurrent_streams`. The hourly limit specifically prevents start/stop abuse of expensive agents. Defaults: 60/min, 300/hr, 2 concurrent. |
| Local admin is single-account only | Only one local account can exist (fixed `sub = local:admin`). Intended as emergency/bootstrap access, not a general user store. |

---

## Explicitly Out of Scope

- Embeddings, vector DB, RAG (handled upstream in LiteLLM pipelines)
- Canvas / whiteboard / collaborative editing
- Plugin marketplace or user-installable extensions
- Fine-tuning or model management
- Inference — anything that loads a model

---

## Implementation Notes

### Stream event format for tool calls

LiteLLM's streaming format for tool calls follows the OpenAI delta protocol (`tool_calls` deltas). The relay must reconstruct full tool call objects from deltas before persisting them to SQLite and emitting display events. Partial JSON arrives across multiple chunks — the accumulation logic needs to handle this correctly.

### File attachments and RAG

Image attachments are in scope (stored in `/data/uploads/`, sent as `image_url` content parts). Document RAG (PDFs, text files) is out of scope — if LiteLLM exposes a `/files` endpoint the user can upload there directly; otherwise RAG is a LiteLLM-side concern.

### YAML write-back and read-only mounts

YAML files are written atomically: the server writes to a temp file in the same directory, then `rename()`s it into place, ensuring no corrupt config on crash.

On startup, the server probes each config file for write access. If a file is on a read-only mount (immutable setups, GitOps-managed configs), the server starts normally but the admin UI disables the corresponding edit controls and shows a clear indicator: "Config is read-only — edit the mounted file directly." This degrades gracefully rather than failing.

### Health check

`GET /health` returns `200 OK` with `{"status":"ok","db":true,"litellm":false}`. `litellm` is `false` when LiteLLM is unreachable or not configured — the server is still healthy; only AI features are unavailable. Used by Docker `healthcheck` and reverse proxy probes.

### No-LiteLLM mode

When `litellm.base_url` is not set (or the server is unreachable), the app starts and runs fully. Conversation management, editing, folder organization, prompts, presets, and automations all work. Sending a chat message returns a 503 error to the composer, which displays it inline. The model picker returns only YAML-declared models (empty list if none). No UI state becomes broken or unusable.

### Completion sound

When the browser receives a `{"type": "done"}` SSE event, it plays a short audio cue (a small bundled audio file, ~10 KB). Configurable per-user (on/off, volume) via `user_preferences`. On by default.