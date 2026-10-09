import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth.ts';
import { generateId, runTransaction, safeParseJson, type TxDb } from './db/index.ts';
import { getConfig, providerIdentity } from './config.ts';
import { acquireStream, closeStream } from './ratelimit.ts';
import { fetchModels } from './models.ts';
import { logger } from './logger.ts';
import type { ConversationRow, MessageContentPart, MessageRow, ModelYamlEntry, SessionPayload } from './types.ts';
import { InputError, contentPartSchema, canonicalizeAttachments, createAttachmentResolver, createRequestBudget } from './attachment-transport.ts';
import { AdmissionError, assertQueueCapacity } from './work-admission.ts';
import { attachUploadsToMessage, cleanupUnreferencedUploads } from './uploads.ts';
import { createBackgroundSseResponse } from './background-sse.ts';
import { cancelGeneration, getGeneration, isActiveGenerationConflict, runGeneration } from './generation-worker.ts';
import { serializeJson } from './serialization.ts';

function contentPartsToText(content: MessageContentPart[]): string {
  return content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text).join('\n');
}

const chatRequestSchema = z.object({
  conversation_id: z.string().uuid().nullable().optional(),
  model: z.string().trim().min(1).max(300),
  system_prompt: z.string().max(100_000).optional(),
  assistant_message_id: z.string().uuid().optional(),
  edit_message_id: z.string().uuid().optional(),
  new_user_message: z.object({
    id: z.string().uuid().optional(),
    content: z.array(contentPartSchema).min(1).max(200),
  }),
});
const regenerateRequestSchema = z.object({
  conversation_id: z.string().uuid(),
  assistant_message_id: z.string().uuid(),
  model: z.string().trim().min(1).max(300),
  system_prompt: z.string().max(100_000).optional(),
});

export const relayRouter = new Hono();
relayRouter.use('*', requireAuth);

export async function buildOpenaiMessages(stored: MessageRow[], latest: MessageContentPart[], prompt: string, model: ModelYamlEntry, owner: string, db: TxDb, messages: unknown[] = []): Promise<unknown[]> {
  const manifest: Array<{role:string;content:string|MessageContentPart[]}> = [];
  const budget = createRequestBudget(model);
  if (prompt) {
    manifest.push({role:'system',content:prompt});
  }
  for (const message of stored) {
    // Interrupted output remains visible, but is not a completed assistant turn.
    if ((message.status !== null && message.status !== 'done') || !['user','assistant'].includes(message.role)) continue;
    let content = safeParseJson<MessageContentPart[]>(message.content,[]);
    if (!content.length && message.content_text) content = [{type:'text',text:message.content_text}];
    manifest.push({role:message.role,content});
  }
  manifest.push({role:'user',content:latest});
  const resolve = await createAttachmentResolver(manifest, owner, model, db);
  for (const [index, message] of manifest.entries()) {
    if (index === manifest.length - 1) {
      const attachmentCount=manifest.reduce((sum,entry)=>sum+(typeof entry.content==='string'?0:entry.content.filter(part=>part.type!=='text').length),0);
      if(attachmentCount>getConfig().attachments.max_files)throw new InputError('Conversation exceeds the attachment count limit');
    }
    const input = { role: message.role, content: typeof message.content === 'string' ? message.content : await resolve(message.content, message.role) };
    messages.push(input);
    await budget.add(input);
  }
  budget.finish();
  return manifest;
}
async function effectivePrompt(conv: ConversationRow, supplied: string | undefined, db: TxDb): Promise<string> {
  if (supplied !== undefined) return supplied;
  if (conv.custom_system_prompt !== null) return conv.custom_system_prompt;
  const preset = conv.preset_id ? await db.prepare('SELECT system_prompt FROM model_presets WHERE id=?').get<{ system_prompt: string }>(conv.preset_id) : null;
  const prompt = conv.system_prompt_id ? await db.prepare('SELECT content FROM system_prompts WHERE id=?').get<{ content: string }>(conv.system_prompt_id) : null;
  return preset?.system_prompt ?? prompt?.content ?? '';
}
async function removeTail(db: TxDb, convId: string, from: MessageRow, owner: string): Promise<void> {
  const uploads = await db.prepare('SELECT DISTINCT mu.upload_id FROM message_uploads mu JOIN messages m ON m.id=mu.message_id WHERE m.conversation_id=? AND (m.timestamp,m.id)>=(?,?)').all<{upload_id:string}>(convId,from.timestamp,from.id);
  await db.prepare('DELETE FROM messages WHERE conversation_id=? AND (timestamp,id)>=(?,?)').run(convId,from.timestamp,from.id);
  await cleanupUnreferencedUploads(db,owner,uploads.map(row=>row.upload_id));
}
async function pinGenerationUploads(db: TxDb, id:string, messages:unknown[]):Promise<void>{
  const ids=new Set<string>();
  for(const message of messages as Array<{content:string|MessageContentPart[]}>){
    if(typeof message.content==='string')continue;
    for(const part of message.content){
      const url=part.type==='image_url'?part.image_url.url:part.type==='file'?part.file.url:'';
      if(url.startsWith('/api/uploads/'))ids.add(url.slice('/api/uploads/'.length));
    }
  }
  if (ids.size) await db.prepare('INSERT INTO generation_uploads (generation_id,upload_id) SELECT ?::uuid, unnest(?::uuid[]) ON CONFLICT DO NOTHING').run(id,[...ids]);
}
function requestError(error: unknown): { error:string; status:400|404|409|429 } | null {
  if (error instanceof InputError) return { error:error.message,status:400 };
  if (error instanceof AdmissionError) return {error:error.message,status:429};
  if ((error as Error).message === 'NOT_FOUND') return {error:'Not found',status:404};
  if ((error as Error).message === 'ACTIVE_GENERATION' || isActiveGenerationConflict(error)) return {error:'This conversation already has a response in progress',status:409};
  return null;
}

interface StreamContext {
  user: SessionPayload;
  convId: string;
  assistantMsgId: string;
  acceptedUser: MessageRow;
  acceptedContent: MessageContentPart[];
  input: unknown[];
  config: ReturnType<typeof getConfig>;
  manifest: unknown[];
  model: ModelYamlEntry;
}

function createChatResponse(context: StreamContext): Response {
  const { user, convId, assistantMsgId, acceptedUser, acceptedContent, input, config, manifest, model } = context;
  return createBackgroundSseResponse({
    type: 'accepted',
    conversation_id: convId,
    assistant_message_id: assistantMsgId,
    user_message: { ...acceptedUser, content: safeParseJson<MessageContentPart[]>(acceptedUser.content, acceptedContent) },
  }, async client => {
    // The durable worker owns the upstream request. This HTTP stream is only an
    // observer and may disappear without affecting the generation job.
    await runGeneration(assistantMsgId, client, { input, config, manifest, model });
  }, error => {
    logger.error('Detached chat observer failed', { user_sub: user.sub, conv_id: convId, generation_id: assistantMsgId, error: String(error) });
  });
}

function generationSnapshot(
  cfg: ReturnType<typeof getConfig>,
  model: string,
  openaiMessages: unknown[],
  titlePrompt: string,
  isFirstExchange: boolean,
  modelEntry: ModelYamlEntry,
) {
  return {
    model,
    model_entry: modelEntry,
    provider: providerIdentity(cfg),
    input_messages: openaiMessages,
    transport_version: 2,
    title_prompt: titlePrompt,
    is_first_exchange: isFirstExchange,
    auto_title: cfg.conversation.auto_title,
    auto_title_model: cfg.conversation.auto_title_model,
    auto_title_prompt: cfg.conversation.auto_title_prompt,
  };
}

async function findModel(userRole: string, model: string) {
  const allowedModels = await fetchModels(userRole);
  const modelEntry = allowedModels.find(entry => entry.id === model);
  return modelEntry;
}

relayRouter.post('/', async c => {
  const user = c.get('user'), cfg = getConfig();
  if (!cfg.openai.base_url) return c.json({error:'OpenAI-compatible endpoint is not configured.'},503);
  const parsed = chatRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({error:'Invalid chat request. Attachments must use managed upload references.'},400);
  const body = parsed.data, model = await findModel(user.role,body.model);
  if (!model) return c.json({error:'Model not available'},400);
  const rl = await acquireStream(user.sub);
  if (!rl.allowed) return c.json({error:rl.reason},429);
  const convId = body.conversation_id ?? generateId(), assistantMsgId = body.assistant_message_id ?? generateId();
  try {
    const accepted = await runTransaction(async db => {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(convId);
      let conv = await db.prepare('SELECT * FROM conversations WHERE id=? AND owner_sub=? FOR UPDATE').get<ConversationRow>(convId,user.sub);
      if (!conv && body.conversation_id) throw new Error('NOT_FOUND');
      if (!conv) {
        await db.prepare('INSERT INTO conversations (id,owner_sub,model_id,custom_system_prompt) VALUES (?,?,?,?)').run(convId,user.sub,body.model,body.system_prompt ?? null);
        conv = (await db.prepare('SELECT * FROM conversations WHERE id=?').get<ConversationRow>(convId))!;
      }
      if (await db.prepare("SELECT id FROM chat_generations WHERE conversation_id=? AND status IN ('queued','running')").get(convId)) throw new Error('ACTIVE_GENERATION');
      const existing = await db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp,id').all<MessageRow>(convId);
      const editIndex = body.edit_message_id ? existing.findIndex(m=>m.id===body.edit_message_id && m.role==='user') : -1;
      if (body.edit_message_id && editIndex < 0) throw new InputError('User message cannot be edited');
      const original = editIndex >= 0 ? existing[editIndex] : null;
      // Text editing preserves every original attachment. Removing an attachment
      // is a separate explicit content operation, never an effect of editing text.
      let content = body.new_user_message.content as MessageContentPart[];
      if (original) content = [...content.filter(p=>p.type==='text'), ...safeParseJson<MessageContentPart[]>(original.content,[]).filter(p=>p.type!=='text')];
      content = await canonicalizeAttachments(content,user.sub,db);
      const retained = editIndex >= 0 ? existing.slice(0,editIndex) : existing;
      const prompt = await effectivePrompt(conv,body.system_prompt,db);
      const input: unknown[] = [];
      const upstream = await buildOpenaiMessages(retained,content,prompt,model,user.sub,db,input);
      const requestSnapshot = await serializeJson(generationSnapshot(cfg,body.model,upstream,contentPartsToText(content),retained.every(message=>message.role!=='user'),model));
      const contentJson = await serializeJson(content);
      const timestamp = original?.timestamp ?? Math.max(Date.now(),(existing.at(-1)?.timestamp ?? 0)+1);
      const userId = original?.id ?? body.new_user_message.id ?? generateId();
      if (original) {
        await db.prepare('UPDATE messages SET content=?,content_text=?,edited_at=? WHERE id=?').run(contentJson,contentPartsToText(content),Date.now(),userId);
        // Keep the edited message and its upload links while truncating its tail.
        if (existing[editIndex+1]) await removeTail(db,convId,existing[editIndex+1],user.sub);
      } else {
        await db.prepare("INSERT INTO messages (id,conversation_id,role,content,content_text,status,timestamp) VALUES (?,?,'user',?,?,'done',?)").run(userId,convId,contentJson,contentPartsToText(content),timestamp);
      }
      await attachUploadsToMessage(db,userId,user.sub,contentJson);
      await db.prepare('UPDATE conversations SET custom_system_prompt=?, model_id=? WHERE id=?').run(prompt,body.model,convId);
      await db.prepare("INSERT INTO messages (id,conversation_id,role,content,content_text,model,status,timestamp) VALUES (?,?,'assistant','[]','',?,'streaming',?)").run(assistantMsgId,convId,body.model,Math.max(Date.now(),timestamp+1));
      await assertQueueCapacity(db);
      await db.prepare("INSERT INTO chat_generations (id,conversation_id,user_message_id,assistant_message_id,owner_sub,request_snapshot,status,rate_lease_id,available_at) VALUES (?,?,?,?,?,?,'queued',?,?)")
        .run(assistantMsgId,convId,userId,assistantMsgId,user.sub,requestSnapshot,rl.leaseId!,Date.now());
      await pinGenerationUploads(db,assistantMsgId,upstream);
      return { message:(await db.prepare('SELECT * FROM messages WHERE id=?').get<MessageRow>(userId))!,content,input,manifest:upstream };
    });
    return createChatResponse({user,convId,assistantMsgId,acceptedUser:accepted.message,acceptedContent:accepted.content,input:accepted.input,config:cfg,manifest:accepted.manifest,model});
  } catch(error) {
    await closeStream(rl.leaseId!).catch(()=>{});
    const failure = requestError(error); if(failure) return c.json({error:failure.error},failure.status);
    throw error;
  }
});

relayRouter.post('/regenerate', async c => {
  const user=c.get('user'), cfg=getConfig();
  const parsed=regenerateRequestSchema.safeParse(await c.req.json());
  if(!parsed.success) return c.json({error:'Invalid regeneration request'},400);
  const body=parsed.data, model=await findModel(user.role,body.model);
  if(!model) return c.json({error:'Model not available'},400);
  const rl=await acquireStream(user.sub); if(!rl.allowed) return c.json({error:rl.reason},429);
  const assistantMsgId=generateId();
  try {
    const userMessage=await runTransaction(async db=>{
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(body.conversation_id);
      const conv=await db.prepare('SELECT * FROM conversations WHERE id=? AND owner_sub=? FOR UPDATE').get<ConversationRow>(body.conversation_id,user.sub);
      if(!conv) throw new Error('NOT_FOUND');
      if(await db.prepare("SELECT id FROM chat_generations WHERE conversation_id=? AND status IN ('queued','running')").get(conv.id)) throw new Error('ACTIVE_GENERATION');
      const stored=await db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp,id').all<MessageRow>(conv.id);
      const index=stored.findIndex(m=>m.id===body.assistant_message_id && m.role==='assistant');
      if(index<1 || stored[index-1].role!=='user') throw new InputError('Assistant message cannot be regenerated');
      const prompt=await effectivePrompt(conv,body.system_prompt,db), message=stored[index-1];
      const content=safeParseJson<MessageContentPart[]>(message.content,[]);
      const input: unknown[] = [];
      const upstream=await buildOpenaiMessages(stored.slice(0,index-1),content,prompt,model,user.sub,db,input);
      const requestSnapshot=await serializeJson(generationSnapshot(cfg,body.model,upstream,contentPartsToText(content),false,model));
      await removeTail(db,conv.id,stored[index],user.sub);
      await db.prepare("INSERT INTO messages (id,conversation_id,role,content,content_text,model,status,timestamp) VALUES (?,?,'assistant','[]','',?,'streaming',?)").run(assistantMsgId,conv.id,body.model,Math.max(Date.now(),message.timestamp+1));
      await assertQueueCapacity(db);
      await db.prepare("INSERT INTO chat_generations (id,conversation_id,user_message_id,assistant_message_id,owner_sub,request_snapshot,status,rate_lease_id,available_at) VALUES (?,?,?,?,?,?,'queued',?,?)")
        .run(assistantMsgId,conv.id,message.id,assistantMsgId,user.sub,requestSnapshot,rl.leaseId!,Date.now());
      await pinGenerationUploads(db,assistantMsgId,upstream);
      return { message, input, manifest:upstream };
    });
    return createChatResponse({user,convId:body.conversation_id,assistantMsgId,acceptedUser:userMessage.message,acceptedContent:safeParseJson(userMessage.message.content,[]),input:userMessage.input,config:cfg,manifest:userMessage.manifest,model});
  } catch(error) {
    await closeStream(rl.leaseId!).catch(()=>{});
    const failure=requestError(error);if(failure)return c.json({error:failure.error},failure.status);throw error;
  }
});

relayRouter.get('/generations/:id', async c => {
  const generation = await getGeneration(c.req.param('id'), c.get('user').sub);
  return generation ? c.json(generation) : c.json({ error: 'Not found' }, 404);
});

relayRouter.post('/generations/:id/cancel', async c => {
  const generation = await cancelGeneration(c.req.param('id'), c.get('user').sub);
  return generation ? c.json(generation) : c.json({ error: 'Not found' }, 404);
});
