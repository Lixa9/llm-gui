export type Role = 'admin' | 'user';

// File attachments in the composer
export interface UploadedAttachment {
  type: 'image' | 'file';  // 'file' covers PDF, Office, OpenDocument, and other binaries
  name: string;
  url: string;        // /uploads/... server path
}

export interface TextFileAttachment {
  type: 'text_file';
  name: string;
  content: string;    // read client-side, injected as text content part
}

export type Attachment = UploadedAttachment | TextFileAttachment;

export interface User {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

export interface ContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type MessageContentPart = ContentPart | ImageContentPart;

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  index: number;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
}

export type MessageStatus = 'done' | 'aborted';

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContentPart[];
  tool_calls: ToolCall[] | null;
  tool_results: ToolResult[] | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  status: MessageStatus | null;
  timestamp: number;
  edited_at: number | null;
}

export interface ConversationFolder {
  id: string;
  owner_sub: string;
  name: string;
  parent_id: string | null;
  created_at: number;
}

export interface Conversation {
  id: string;
  owner_sub: string;
  title: string;
  title_auto: boolean;
  model_id: string | null;
  system_prompt_id: string | null;
  custom_system_prompt: string | null;
  folder_id: string | null;
  pinned: boolean;
  forked_from_id: string | null;
  forked_at_message_id: string | null;
  created_at: number;
  folder_name?: string;
  forked_from_title?: string;
  message_count?: number;
  last_message_at?: number;
}

export interface SystemPrompt {
  id: string;
  owner_sub: string | null;
  name: string;
  content: string;
  visible_to: Role[] | null;
  created_at: number;
  deleted_at: number | null;
}

export interface ModelInfo {
  id: string;
  display_name: string;
  show_tool_calls: boolean;
  allowed_roles: Role[];
}

export interface ModelPreset {
  id: string;
  owner_sub: string;
  name: string;
  base_model_id: string;
  system_prompt: string;
  created_at: number;
}

export type AutomationType = 'scheduled' | 'pipeline';

export type ScheduleUnit = 'hours' | 'days' | 'weeks';

export interface ScheduledDefinition {
  interval: number;
  unit: ScheduleUnit;
  model: string;
  system_prompt: string;
  user_prompt: string;
  output: 'new_conversation';
}

export interface PipelineStep {
  model: string;
  system_prompt: string;
  user_prompt: string;
}

export interface PipelineDefinition {
  steps: PipelineStep[];
}

export type AutomationDefinition = ScheduledDefinition | PipelineDefinition;

export interface Automation {
  id: string;
  owner_sub: string | null;
  name: string;
  type: AutomationType;
  definition: AutomationDefinition;
  enabled: boolean;
  created_at: number;
  deleted_at: number | null;
}

export type AutomationRunStatus = 'running' | 'done' | 'error';

export interface AutomationRun {
  id: string;
  automation_id: string;
  started_at: number;
  conversation_id: string | null;
  status: AutomationRunStatus;
  error: string | null;
}

export interface UserPreferences {
  sound_enabled: string;
  sound_volume: string;
  default_model_id: string;
  default_system_prompt: string;
  [key: string]: string;
}

// SSE event types emitted by the relay
export type SSEEvent =
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown; index: number }
  | { type: 'tool_result'; tool_call_id: string; content: string }
  | { type: 'done'; tokens_in?: number; tokens_out?: number }
  | { type: 'title'; title: string }
  | { type: 'error'; message: string };

// API request/response types
export interface ChatPayload {
  conversation_id: string | null;
  model: string;
  system_prompt?: string;
  system_prompt_id?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: MessageContentPart[];
    tool_calls?: ToolCall[];
    tool_results?: ToolResult[];
  }>;
  new_user_message: {
    content: MessageContentPart[];
  };
}

export interface AdminUser {
  sub: string;
  email: string;
  name: string;
  role_override: Role | null;
  resolved_role: Role;
  created_at: number;
}

export interface ConfigFile {
  name: string;
  content: string;
  writable: boolean;
}

export interface ApiError {
  status: number;
  message: string;
}
