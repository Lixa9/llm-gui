export type Role = 'admin' | 'user';

// Hono variable map augmentation — allows c.get('user') without casting in all routers
declare module 'hono' {
  interface ContextVariableMap {
    user: SessionPayload;
  }
}

export interface ContentPart {
  type: 'text';
  text: string;
}

export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string };
  _filename?: string;
}

export interface FilePart {
  type: 'file';
  file: { url: string };
  _filename?: string;
}

export type MessageContentPart = ContentPart | ImageUrlPart | FilePart;

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  index: number;
}

export type MessageStatus = 'done' | 'aborted';

// DB row types (snake_case)
export interface UserRow {
  sub: string;
  email: string;
  name: string;
  role_override: Role | null;
  created_at: number;
}

export interface UserPrefRow {
  user_sub: string;
  key: string;
  value: string;
  updated_at: number;
}


export interface ConversationRow {
  id: string;
  owner_sub: string;
  title: string;
  title_auto: number;
  model_id: string | null;
  preset_id: string | null;
  system_prompt_id: string | null;
  custom_system_prompt: string | null;
  folder_id: string | null;
  pinned: number;
  forked_from_id: string | null;
  forked_at_message_id: string | null;
  created_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  content_text: string;
  tool_calls: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  status: MessageStatus | null;
  timestamp: number;
  edited_at: number | null;
}

export interface SystemPromptRow {
  id: string;
  owner_sub: string | null;
  name: string;
  content: string;
  visible_to: string | null;
  created_at: number;
  deleted_at: number | null;
}

export interface ModelPresetRow {
  id: string;
  owner_sub: string | null;
  name: string;
  base_model_id: string;
  system_prompt: string;
  created_at: number;
  visible_to: string | null;
  deleted_at: number | null;
}

export interface AutomationRow {
  id: string;
  owner_sub: string | null;
  name: string;
  type: string;
  definition: string;
  enabled: number;
  created_at: number;
  deleted_at: number | null;
  visible_to: string | null;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  started_at: number;
  conversation_id: string | null;
  status: string;
  error: string | null;
}

// Session JWT payload
export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
  method: 'oidc' | 'local';
  jti: string;
  exp: number;
  iat: number;
}

// Config types
export interface AppConfig {
  app: {
    name: string;
    base_url: string;
    secret_key: string;
  };
  litellm: {
    base_url: string;
    api_key?: string;
  };
  database: {
    path: string;
  };
  oidc?: {
    issuer: string;
    client_id: string;
    client_secret: string;
    scopes: string[];
  };
  rbac: {
    group_claim: string;
    mappings: Array<{ oidc_group: string; role: Role }>;
    default_role: Role;
  };
  rate_limits: {
    requests_per_minute: number;
    requests_per_hour: number;
    concurrent_streams: number;
  };
  conversation: {
    auto_title: boolean;
    auto_title_model: string;
    context_window_tokens: number;
    context_window_reserve: number;
  };
  models?: ModelYamlEntry[];
  prompts?: PromptYamlEntry[];
  automations?: AutomationYamlEntry[];
  presets?: PresetYamlEntry[];
}

export interface ModelYamlEntry {
  id: string;
  display_name: string;
  show_tool_calls: boolean;
  allowed_roles: Role[];
  context_window_tokens?: number;
  context_mode?: 'truncate' | 'passthrough' | 'session_only';
}

export interface PromptYamlEntry {
  name: string;
  content: string;
  allowed_roles?: Role[];
}

export interface PresetYamlEntry {
  name: string;
  base_model_id: string;
  system_prompt?: string;
  allowed_roles?: Role[];
}

export type ScheduleUnit = 'hours' | 'days' | 'weeks';

export interface ScheduledDefinition {
  interval: number;
  unit: ScheduleUnit;
  model: string;
  system_prompt?: string;
  user_prompt: string;
  output?: 'new_conversation';
}

export interface PipelineStep {
  model: string;
  system_prompt?: string;
  user_prompt: string;
}

export interface PipelineDefinition {
  steps: PipelineStep[];
}

export interface AutomationYamlEntry {
  name: string;
  type: 'scheduled' | 'pipeline';
  interval?: number;
  unit?: ScheduleUnit;
  allowed_roles?: Role[];
  model?: string;
  system_prompt?: string;
  user_prompt?: string;
  output?: string;
  steps?: Array<{ model: string; system_prompt: string; user_prompt: string }>;
}
