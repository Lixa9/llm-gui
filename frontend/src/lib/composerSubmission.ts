import type { ChatSendResult } from './types';

export interface ComposerReadiness {
  streaming: boolean;
  submitting: boolean;
  hasContent: boolean;
  hasReadyAttachment: boolean;
  hasUploadingAttachment: boolean;
  hasModel: boolean;
}

export function canSubmitComposerDraft(state: ComposerReadiness): boolean {
  return !state.streaming
    && !state.submitting
    && !state.hasUploadingAttachment
    && state.hasModel
    && (state.hasContent || state.hasReadyAttachment);
}

export async function submitComposerDraft(
  send: () => Promise<ChatSendResult>,
  clearAcceptedDraft: () => void,
): Promise<ChatSendResult> {
  const result = await send();
  if (result.accepted) clearAcceptedDraft();
  return result;
}

export async function deleteUploadBestEffort(
  uploadId: string,
  remove: (id: string) => Promise<void>,
): Promise<boolean> {
  try {
    await remove(uploadId);
    return true;
  } catch {
    return false;
  }
}
