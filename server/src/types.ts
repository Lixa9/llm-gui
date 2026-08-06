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

export type MessageStatus = 'done' | 'aborted';

// DB row types (snake_case)
export interface UserRow {
  sub: string;
  email: string;
  name: string;
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
  title_auto: boolean;
  model_id: string | null;
  preset_id: string | null;
  system_prompt_id: string | null;
  custom_system_prompt: string | null;
  folder_id: string | null;
  pinned: boolean;
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
  model: string | null;
  status: MessageStatus | null;
  timestamp: number;
  edited_at: number | null;
}

export interface SystemPromptRow {
  id: string;
  owner_sub: string | null;
  name: string;
  content: string;
  visible_to: string[] | null;
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
  visible_to: string[] | null;
  deleted_at: number | null;
}

export interface AutomationRow {
  id: string;
  owner_sub: string | null;
  name: string;
  type: string;
  definition: Record<string, unknown>;
  enabled: boolean;
  created_at: number;
  deleted_at: number | null;
  visible_to: string[] | null;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  started_at: number;
  conversation_id: string | null;
  status: string;
  error: string | null;
}

// Session identity loaded from the server-side session record.
export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
  method: 'oidc' | 'local';
  sessionId: string;
  expiresAt: number;
}

// Config types
export interface AppConfig {
  app: {
    name: string;
    base_url: string;
  };
  openai: {
    base_url: string;
    api_key?: string;
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
  storage: {
    quota: number;
  };
  conversation: {
    auto_title: boolean;
    auto_title_model: string;
  };
  models?: ModelYamlEntry[];
  prompts?: PromptYamlEntry[];
  automations?: AutomationYamlEntry[];
  presets?: PresetYamlEntry[];
}

export interface ModelYamlEntry {
  id: string;
  display_name: string;
  allowed_roles: Role[];
  history_mode?: 'full' | 'latest_only';
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
}

export interface AutomationYamlEntry {
  name: string;
  interval?: number;
  unit?: ScheduleUnit;
  allowed_roles?: Role[];
  model?: string;
  system_prompt?: string;
  user_prompt?: string;
}
