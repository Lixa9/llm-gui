import { processFile } from './file-processing.ts';
process.once('message', async (message: { bytes: Buffer; mime: string; filename: string }) => {
  try {
    process.send?.({ result: await processFile(Buffer.from(message.bytes), message.mime, message.filename) });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : 'Document processing failed' });
  }
});
