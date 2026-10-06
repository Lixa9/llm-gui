export const DEFAULT_AUTO_TITLE_PROMPT = 'Return a 4-6 word title for this conversation. No punctuation, no quotes.';

export interface TitleRequestSnapshot {
  provider?: { base_url: string; revision: string };
  model?: string;
  system_prompt?: string;
  title_prompt: string;
  assistant_response: string;
}

export function buildTitleRequest(snapshot: TitleRequestSnapshot) {
  if (typeof snapshot.model !== 'string' || !snapshot.model.trim()) {
    throw new Error('Auto-title requires an explicit model. Set conversation.auto_title_model and resubmit this request.');
  }
  const systemPrompt = snapshot.system_prompt === undefined ? DEFAULT_AUTO_TITLE_PROMPT : snapshot.system_prompt;
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('Auto-title requires a nonempty conversation.auto_title_prompt.');
  }
  if (!snapshot.title_prompt || !snapshot.assistant_response) throw new Error('Invalid title job snapshot');
  return {
    model: snapshot.model.trim(),
    stream: false,
    max_tokens: 20,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${snapshot.title_prompt}\n\n${snapshot.assistant_response}`.slice(0, 2000) },
    ],
  };
}
