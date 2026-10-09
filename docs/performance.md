# Performance and compatibility

The health endpoint bypasses compression but retains its JSON body and 200/503 status codes. It remains a process-liveness check, not a dependency-readiness check.

Large JSON serialization uses one reusable worker thread, while request budgets accumulate the exact serialized size of each message once. The request format, complete history, attachment ordering, image detail, native PDF data, model parameters, input limits, and error messages remain unchanged. Upload resolution batches owner-scoped reads and only selects original bytes when the selected representation requires them. A directly started generation can reuse prepared input only for its first attempt and only when its durable manifest, model settings, and active configuration match. Recovered jobs still reconstruct input from the durable snapshot; prepared binary content is not stored in a process-global cache.

The global queue-admission lock is acquired after expensive preparation and message writes, immediately before inserting the generation. All writes stay in the same transaction, so a full queue still rolls back the request. Conversation locking, attachment references, worker admission, and authorization checks remain in place.

Checkpoint writes run independently of token consumption, with one in-flight write per generation and a coalesced latest pending state. The target interval remains 500 ms. Terminal handling drains outstanding writes, and checkpoint updates lock the owning generation and fence its lease, attempt, and message status. Slow databases can skip intermediate saved states; terminal content remains authoritative. Existing browser-disconnect and worker-recovery behavior remains intact.

## Observable changes

- `/health` no longer returns compression headers or compressed bytes, even when the client requests gzip.
- Model discovery requests are coalesced. A five-second background timer refreshes the model cache starting at 45 seconds of age, before its unchanged 60-second expiration. Expired or empty caches still wait for refresh; failure fallback and role filtering remain unchanged.
- Streaming output is not held up by periodic database writes. SSE event types and payloads are unchanged, but their timing can improve.
- Streaming Markdown is rendered at most once every 50 ms, with immediate final rendering. Code highlighting has a bounded cache, and every HTML render is still sanitized.
- Configuration polling uses asynchronous reads every five seconds and avoids parsing unchanged files. Semantic no-op edits do not invalidate caches. SIGHUP, invalid-configuration fallback, shared activation fencing, and serialized activation remain supported.
- Request logs retain method/path/status/ms, now with submillisecond precision and compression setup included. They do not measure socket completion or time spent waiting before middleware entry. A once-per-minute `event_loop` log records p95/max delay. Generation diagnostics add queue, preparation, upstream-first-token, and attempt timings without recording request content or credentials.

## Validation

The serializer limits posted work to two jobs on its single worker thread; additional callers wait for capacity rather than copying an unbounded number of payloads into a worker queue.

From the repository root:

```sh
npm --prefix server run typecheck
npm --prefix server test
npm --prefix frontend run check
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix server run test:performance
```

The performance benchmark compares legacy compression and repeated history serialization against the optimized implementations in-process. It reports health p50/p95/p99, serialized bytes, total budget time, and timer delay. These are local microbenchmarks, not claims about production HTTP latency.

For actual HTTP latency, run the benchmark against the running server:

```sh
npm --prefix server run test:performance -- --url=http://127.0.0.1:3000/health
```

Repeat against the public/proxied health URL and while issuing large chats or uploads to distinguish event-loop pressure from proxy, TLS, and network delays. Compare identical deployments and loads; do not use absolute microbenchmark thresholds as functional test assertions.

PostgreSQL integration tests require a dedicated disposable database, local HTTP listeners, and document-processing dependencies:

```sh
GENERATION_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST/TEST_DATABASE npm --prefix server run test:integration
```

Never point the integration suite at an application database containing real user data.
