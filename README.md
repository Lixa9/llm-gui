# LLM Chat Frontend

A self-hosted chat frontend for [LiteLLM](https://github.com/BerriAI/litellm) (or any OpenAI-compatible API). Single container, no cloud dependencies, no inference inside the box.

## Features

### Chat
- Streaming responses with a stop button that cancels the upstream request immediately
- Image attachments — paste or drag-and-drop; images are stored on the server and sent to the model as base64
- Tool call display — when LiteLLM uses tools, each call appears as a collapsible block showing the function name, arguments, and result. Visibility is configurable per model in `models.yaml`
- Auto-generated conversation titles after the first exchange (using a cheap model you configure)
- Sliding context window — older messages are quietly trimmed before the request if the conversation exceeds your configured token budget; they are never deleted from the database

### Per-message actions
- **Edit** — edit a user message and automatically regenerate the reply, or directly edit an assistant message without re-sending
- **Regenerate** — re-run the model from any assistant message
- **Fork** — create a new conversation branching from any message, with a link back to the original
- **Copy / Delete**

### Conversation management
- Sidebar with folder tree (unlimited nesting, drag-and-drop to move)
- Full-text search across all message content
- Pin, duplicate, rename, move to folder, delete
- Delete all conversations at once

### Prompt library
- Create and reuse named system prompts
- Admin-seeded prompts from `prompts.yaml` appear for all users (read-only)

### Model presets
- Save a model + system prompt combination as a named preset
- Selecting a preset pre-fills the model and system prompt when starting a conversation

### Automations
- Schedule a prompt to run automatically (every N hours/days/weeks)
- Each run creates a new conversation with the full exchange
- Manual trigger button for testing
- Run history per automation

### Admin panel
- View all users and their OIDC-sourced identity
- Set per-user role overrides (in case OIDC groups can't cover a case)
- View all users' prompts and automations (read-only)
- View mounted config files

### Authentication
- **SSO via OIDC** (Authelia, Keycloak, Authentik, or any compliant provider) using Authorization Code + PKCE
- **Local admin account** — optional fallback enabled by two environment variables; accepts plain text or an argon2/bcrypt hash
- Sessions are stored in the database; logging out fully invalidates the session, and a DB reset invalidates all existing cookies automatically
- RBAC with two roles (`admin`, `user`); role assigned from OIDC group claims with per-user override capability

---

## Design choices

**Pure relay.** The server does no inference, no embeddings, no RAG, no tool execution. It forwards requests to LiteLLM, streams the response to the browser, and saves the conversation to SQLite. LiteLLM owns everything intelligence-related.

**Single container.** The Svelte SPA and the Node.js server are bundled together. SQLite lives in a mounted volume — no separate database container needed.

**Config is YAML, user content is SQLite.** Auth, model display settings, RBAC, and admin-seeded prompts and automations are defined in mounted YAML files. Everything a user creates (conversations, personal prompts, presets, automations) lives in the database. On startup the server reconciles the YAML into the database.

**Models are discovered from LiteLLM.** The `/models` endpoint is polled at startup and cached. `models.yaml` only adds display metadata and role-based access control on top; any model not listed defaults to admin-only.

**Stop = abort.** The browser's `AbortController` closes the SSE connection. The server propagates the abort signal directly to the upstream fetch, so LiteLLM (and any agentic loop it's running) stops immediately — no polling, no special endpoint.

---

## Quick start

### Prerequisites

- Docker and Docker Compose
- A running LiteLLM instance (or any OpenAI-compatible API endpoint)
- Optionally: an OIDC provider for SSO

### 1. Create your working directory

```
mkdir my-chat && cd my-chat
mkdir -p data config
```

### 2. Create `docker-compose.yml`

```yaml
services:
  chat:
    image: ghcr.io/lixa9/llm-gui:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
      - ./config:/app/config
    environment:
      SECRET_KEY: change-me-to-a-random-32-char-string
      # Local admin account — omit both lines to disable
      LOCAL_ADMIN_USERNAME: admin
      LOCAL_ADMIN_PASSWORD: admin
      # Only needed if LiteLLM requires authentication
      # LITELLM_API_KEY: your-key-here
      # Only needed if config.yaml references ${OIDC_CLIENT_SECRET}
      # OIDC_CLIENT_SECRET: your-secret-here
    healthcheck:
      test: ["CMD", "node", "--eval", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: unless-stopped
```

### 3. Create `config/config.yaml`

```yaml
app:
  name: "Chat"
  base_url: "http://localhost:3000"
  secret_key: "${SECRET_KEY}"

litellm:
  base_url: "http://192.168.1.100:4000/v1"  # your LiteLLM address
  # api_key: "${LITELLM_API_KEY}"

database:
  path: "/data/chat.db"

# Remove the oidc block entirely if you only use the local admin account
# oidc:
#   issuer: "https://auth.example.com"
#   client_id: "chat"
#   client_secret: "${OIDC_CLIENT_SECRET}"
#   scopes: ["openid", "profile", "email", "groups"]

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

conversation:
  auto_title: true
  auto_title_model: "gpt-4o-mini"
  context_window_tokens: 100000
```

> **Docker networking note:** use your host machine's LAN IP (or `host.docker.internal` on Mac/Windows) for `litellm.base_url`. `127.0.0.1` inside a container refers to the container itself, not your host.

### 4. Create `config/models.yaml`

Controls which models are visible to which roles and whether tool calls are shown. Any model returned by LiteLLM but not listed here defaults to admin-only.

```yaml
models:
  - id: "openai/gpt-4o"
    display_name: "GPT-4o"
    show_tool_calls: true
    allowed_roles: [admin, user]

  - id: "openai/gpt-4o-mini"
    display_name: "GPT-4o Mini"
    show_tool_calls: true
    allowed_roles: [admin, user]
```

The `id` must match the model ID as LiteLLM returns it from its `/models` endpoint.

### 5. Create `config/prompts.yaml` (optional)

Admin-seeded prompts that appear in every user's prompt library.

```yaml
prompts:
  - name: "Concise assistant"
    content: "You are a helpful assistant. Keep responses short and to the point."
    visible_to: [admin, user]

  - name: "Code reviewer"
    content: "You are an expert code reviewer. Focus on correctness, security, and clarity."
    visible_to: [admin, user]
```

### 6. Create `config/automations.yaml` (optional)

```yaml
automations: []
# Example:
# automations:
#   - name: daily_digest
#     type: scheduled
#     interval: 1
#     unit: days
#     model: gpt-4o-mini
#     system_prompt: "You are a concise summarizer."
#     user_prompt: "Summarize today's key points."
```

### 7. Start

```bash
docker compose up -d
docker compose logs -f
```

Open [http://localhost:3000](http://localhost:3000). Log in with the local admin credentials you set.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SECRET_KEY` | Yes | Signs session JWTs. Any random string ≥ 32 characters. If unset, an ephemeral key is generated and sessions don't survive restarts. |
| `LOCAL_ADMIN_USERNAME` | No | Enables a local admin account. Both vars must be set. |
| `LOCAL_ADMIN_PASSWORD` | No | Accepts plain text or an argon2/bcrypt hash. |
| `OIDC_CLIENT_SECRET` | No | Required only if `config.yaml` references `${OIDC_CLIENT_SECRET}`. |
| `LITELLM_API_KEY` | No | Sent as `Authorization: Bearer` to LiteLLM. Required only if your LiteLLM instance has auth enabled. |

---

## Upgrading

```bash
docker compose pull
docker compose up -d
```

The server runs database migrations automatically on startup.

---

## Building from source

```bash
git clone https://github.com/Lixa9/llm-gui.git
cd llm-gui
docker compose build
docker compose up -d
```

Requires Node.js 22+ if running outside Docker:

```bash
cd frontend && npm ci && npm run build
cd ../server && npm ci
node src/index.ts
```
