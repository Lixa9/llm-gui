# Review implementation — 3 October 2026

This implements the scope selected from [the complete review](project-review.md): Tier 1 and Tier 2 formats, ZIP/TAR/TAR.GZ/GZ from Tier 3, all P1 findings, the attachment fixes D1–D11, private conversation drafts, persistent folder expansion, and optional deployment branding. The original review remains a record of the pre-change implementation.

## Supported inputs and transport

The server publishes one format registry at `/api/uploads/formats`; the composer uses it for file selection. Filename extensions and normalized MIME aliases select a parser, which then reads/verifies the bytes. UTF-8 and BOM-marked UTF-16 are supported. Unknown binary formats are rejected. Source files are read as text and never executed. JSONL includes record numbers and records invalid JSON/partial coverage.

| Family | Processing |
| --- | --- |
| PPTX/PPT/ODP; DOC/DOCX/ODT/RTF | Private, headless LibreOffice conversion to PDF; PDF text plus rendered page images; PPTX speaker notes in slide order |
| PDF | Text extraction plus page rendering, or original native PDF input when enabled for the selected model |
| XLS/XLSX/ODS | XLS conversion to XLSX; bounded sheet/cell extraction with inline/shared strings, cached formula values, dates, booleans, percentages, and CSV quoting |
| JPEG/PNG/WebP/GIF/HEIC/HEIF/BMP/TIFF | ImageMagick normalization/orientation to PNG; first GIF frame; up to 20 TIFF frames |
| SVG | Resvg rasterization, rejecting active content and external references |
| EML | MIME parsing, headers, text/HTML body, supported attachment contents and collection coverage |
| EPUB | Text plus converted supported embedded images; omissions disclosed |
| ZIP/TAR/TAR.GZ/TGZ/GZ | Memory-only, bounded allowlisted children; PAX/GNU long TAR names; reject traversal, links, special files, sparse overrides, malformed headers, and excessive expansion |
| Source/config/log/text/data and aliases | Bounded text decoding, preserving line breaks and filename provenance |

Originals stay in PostgreSQL and remain available through authenticated downloads. Derived previews are private. Coverage/warnings are stored with the upload, retained on messages, and visible after sending. Unsupported or unreadable container entries have an explicit coverage status; nested containers are not expanded.

Application content retains managed `/api/uploads/<id>` references. New inline or external media writes are rejected; legacy supported inline images remain readable and are serialized into fresh provider objects without UI fields. Missing/unsupported historical attachments fail explicitly. Old XLS conversion placeholders require reupload. Office signatures and required package parts are checked before conversion. Conversion failures return HTTP 422 and busy processors return 429, without storing successful-looking uploads.

The provider remains OpenAI-compatible **Chat Completions**. Images use documented base64 `image_url` parts. Models explicitly enabling `native_pdf` use `file: { filename, file_data }` with the original PDF. Uploading a PDF with a native PDF model bypasses local conversion; that native-only upload needs reupload to switch to a fallback route. Both native PDF and rendered document routes require declared vision support. There is no Responses adapter, provider Files API cache, or conversation chaining in this change.

## Findings addressed

| Review item | Result |
| --- | --- |
| D1 | Text edits preserve attachment parts and references. Edit/regenerate validates replacement input and truncates later history in one transaction; rejection leaves the original/history intact. |
| D2 | Processing failures are explicit; XLS is converted instead of returning a placeholder; native PDF uploads do not depend on local extraction. |
| D3 | Full replay has aggregate byte/image/file/text budgets, including historical attachments. Accepted jobs store immutable message/reference and model snapshots rather than expanded media. Generation pins keep uploads available until finalization/cancellation. |
| D4 | PDF text layer, Office layout conversion/PPTX notes, corrected bounded XLSX/ODS parsing, and accurate image conversion improve fidelity. |
| D5 | Validated model capabilities, composer compatibility feedback, server enforcement, configurable image detail, conservative defaults. |
| D6 | Separate app/provider schemas; ownership-checked canonical metadata; fresh provider serialization; explicit invalid/missing references. |
| D7 | Selective transient retry; malformed streams, refusals, tool replies and truncation surface as errors; bounded output; chat request ID/status/finish reason, numeric token usage, input counts and request/output byte diagnostics. Prompts, documents and response text are excluded from diagnostics. |
| D8 | Heavy processing runs in separate child processes with concurrency, heap, time, expansion, pixel/grid and derivative limits. Temporary workspaces and converter process groups are cleaned up. |
| D9 | Shared recognition registry, MIME aliases, UTF-16 BOM decoding, actual conversion/parser checks. |
| D10 | Downloadable originals, private image previews, retained warnings/MIME and coverage inspection. |
| D11 | New media must use quota-accounted managed uploads. Legacy inline media is read-only. |
| G1 (P1) | Conversations persist their effective system prompt, including automation deliveries. Server fallback uses saved instructions; selecting no prompt sends an explicit empty value. Accepted jobs snapshot the effective text. |
| G4 (P1) | Each authenticated request resolves current application role; OIDC groups are reevaluated under current RBAC. Queued chats recheck model access. Scheduled owners/recipients use a defined freshness policy. |
| G5 (P1) | Shared database admission across chat/automation/title jobs and replicas; capped queue and per-owner concurrency; manual-trigger rate limits; one pending run per automation. |
| G6 (P1) | Current role/model access, subscription, visibility, enabled/deleted state are checked before generation and transactionally before delivery. Ineligible recipients are marked skipped. |
| G7 (P1) | Jobs pin provider endpoint and credential revision without storing credentials. Changed providers fail closed. Full YAML schemas/duplicates/limits and configured model references/role access are validated. Shared activation revision fences stale replicas, with five-second shared-mount refresh. |
| G9 (P1 portion) | Output/frame bounds and bounded observer queues; slow observers detach while durable jobs continue. Non-streaming automation/title replies are bounded too. |
| Selected product improvements | Private database-backed conversation drafts, serialized autosaves, upload pins, acceptance-aware clearing and rejected-first-message recovery; per-user folder expansion preferences; optional app name/tagline/logo/accent. |

Related fixes include separating browser stream parse/handler errors, malformed request responses, empty-model fallback, maintenance rejection handling, setting production mode in the image, and compatible server dependency security updates. The remaining general P2/P3 review items (search, folder mutation races, pagination, broad accessibility, ordered migrations/readiness, expanded metrics, submission idempotency, and other optional formats) remain future work.

## Limits and configuration

All new configuration fields have defaults. See [README](../README.md) for examples.

| Limit | Default |
| --- | --- |
| Image/original document or archive | 20 MiB / 50 MiB |
| Resolved replayed messages | 32 MiB JSON, 100 images, 50 attachment/file references, 500,000 text characters |
| Model-specific text bound | Optional `capabilities.max_text_chars`, capped by global bound |
| Native PDF source bytes | Combined less than 50 MiB, also subject to replay byte budget |
| Document processing | 2 concurrent child processes per application replica; 60 seconds; 256 MiB JS heap |
| Converter subprocess | 45 seconds wall time, 35 seconds CPU, 1.5 GiB address space, 128 MiB maximum output file |
| PDF | First 100 pages, 3,000-pixel longest edge, 9 million rendered pixels per page |
| Images | 12,000-pixel source dimension/16 million SVG pixels; 3,000-pixel derivatives; ImageMagick memory/map/disk policies |
| Derived images and text | 24 MiB decoded derivatives; 1,000,000 text characters per upload |
| Archive | 64 MiB expanded, 2,000 entries; up to 50 processed entries/20 images per collection |
| Spreadsheet | 10,000 rows, 256 columns, 100,000 cells/250,000 grid positions per sheet |
| Upstream workers/queue | 8 shared workers, 2 per owner, 200 queued/running jobs; one pending run per automation |
| Chat output/frame | 1,000,000 bytes each; browser observer queue 2 MiB |
| Draft | 1,000,000 text characters and 20 ready attachment references |

Character limits are not exact model token/context accounting. Rendering/extraction has documented partial coverage; it does not guarantee perfect document fidelity. Converter CPU/address/file limits complement parser and process limits; native processing is not a general filesystem/network sandbox. Macro execution and link updating are disabled; OOXML external relationships are removed; SVG active/external references are rejected.

## Upgrade and operational behavior

- Install the updated dependencies and rebuild the image. Direct development installs require LibreOffice Writer/Impress/Calc, ImageMagick with HEIC decoding, fonts, and util-linux `prlimit`. The Dockerfile installs them.
- Capability defaults are `vision:false`, `native_pdf:false`, `stream_usage:false`, `image_detail:auto`. Configure each actual upstream route explicitly; model names alone do not establish protocol support. The checked-in models declare their intended vision support but were not probed against a deployed provider.
- Jobs created before provider identity snapshots existed fail with a resubmit message rather than being sent through an unknown endpoint. Changing endpoint/key also requires resubmitting queued work.
- Existing OIDC sessions without stored groups require login again. Stored groups are reevaluated immediately under new application RBAC; identity-provider changes are learned on login. Scheduled automation role observations expire after 24 hours; signing in refreshes them. Local test authorization remains tied to `LOCAL_AUTH`.
- Replicas need the same config mount. PostgreSQL coordinates activation and admission; stale replicas reject API work/claims until refresh. Independent mounts with conflicting content are not a supported reload mechanism.
- Drafts are private database data; they never use browser localStorage. Ready attachments survive navigation/reload and orphan cleanup. Draft autosave is best effort on abrupt page/process loss; unsaved keystrokes before the debounce completes can be lost. Concurrent tabs use last successful server write, without collaborative merging.
- Default behavior skips overlapping due runs rather than creating an unbounded backlog. Disabled/deleted automations and unsubscribed/restricted recipients receive no pending delivery.
- Existing fallback derivatives remain readable when valid. Unsupported historical derivatives or placeholder uploads require reupload; there is no background reprocessing/migration of document bytes.

## Validation

Executed on Node 26.10.0:

- Server TypeScript, Svelte diagnostics (zero errors/warnings), frontend production build, 29 server unit checks and 15 frontend unit checks.
- PostgreSQL 17 integration against a local mock provider: durable leases/recovery/cancellation, failed edits retaining history, attachments surviving edits, pinned immutable job references, prompt snapshots, draft restore/cleanup pins, current roles, provider change failure, queued unsubscribe delivery suppression, content-free diagnostics and corrupt Office upload rejection without a stored row.
- Full production Docker build succeeded. Actual converter fixtures also passed as the image's non-root user with the latest server source mounted: ODT/DOC/DOCX/RTF/PPT/PPTX/ODP, XLS conversion, PPTX notes, HEIC/TIFF/BMP/SVG PNG normalization (two fixture suites). These exercise the bundled LibreOffice, ImageMagick, Resvg and MuPDF dependencies.
- Chromium browser checks against a disposable database/mock provider: configured name/title/accent, restored new-conversation text and attachment drafts, acceptance-aware clearing, attachment downloads and retention through edit/regenerate, separate drafts across conversations/navigation/reload, and folder collapse persistence. Corrupt upload rejection was verified through the API integration suite.
- Format/text/MIME, corrupt/path/link/long-name archives, gzip, JSONL, XLSX/ODS cells and sparse expansion, email parts, exact native PDF/image provider serialization, missing references, stream/refusal/tool/retry errors and frame/output bounds.
- Server production dependency audit reports zero vulnerabilities. This is not a project-wide audit clearance; frontend dependencies were not changed in this scope.

Run standard checks with `npm --prefix server run typecheck`, `npm --prefix server test`, `npm --prefix frontend run check`, `npm --prefix frontend test`, and `npm --prefix frontend run build`. Integration needs `GENERATION_TEST_DATABASE_URL`; actual converters need `npm --prefix server run test:conversions` with conversion tools installed.

No deployed provider was called, no production data was used, and nothing was deployed. Native PDF/image serialization was verified against documented request structures and local mocks; deployed upstream capability declarations still need to match the actual provider route. Conversion tools materially increase image size, so builds and deployments need adequate disk space.
