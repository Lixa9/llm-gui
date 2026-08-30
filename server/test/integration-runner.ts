if (!process.env.GENERATION_TEST_DATABASE_URL) {
  throw new Error('GENERATION_TEST_DATABASE_URL is required for integration tests');
}

await import('./generation-worker.integration.test.ts');
