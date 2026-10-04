# Conversation transport

Implemented 4 October 2026. This is the current request contract; the earlier review documents describe historical behavior.

## Standard requests and ordinary messages

All backends use `POST /chat/completions` with standard `model`, `messages`, and `stream: true` fields. `stream_options: {include_usage: true}` is included only for a configured backend that supports it. No `session_id` is sent.

A single plain message with no configured system prompt is sent as:

```json
{
  "model": "selected-model",
  "stream": true,
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

Plain user and assistant content is a string, preserving accepted text, whitespace, Markdown, and code. If an internal message has multiple text fragments, they are concatenated without adding characters. There is no wrapper, manifest, default instruction, timestamp, message ID, conversation ID, hash, schema version, or processing metadata in the upstream message.

The effective system prompt is sent once at the start, only when nonempty. It follows the existing precedence: explicitly supplied prompt, saved conversation prompt, preset prompt, then selected shared prompt.

## Full history

Every backend, including an external agent, receives the full active transcript in saved order: configured instructions, accepted user messages and completed assistant replies, then the latest user message. Attachments stay with their original user turns and are expanded again during replay.

Drafts, empty generation placeholders, internal errors, and failed/cancelled/timed-out assistant output are excluded. Interrupted output stays in the database and UI, with an explanation that it is excluded from subsequent requests. Legacy messages with a null status are treated as completed for compatibility; legacy completed messages with only `content_text` retain that text.

Editing truncates the active tail only after validation succeeds. Regeneration sends history through the relevant user message and excludes the answer being replaced. Switching models preserves history subject to capability and request limits. Generation snapshots retain managed references and pinned uploads; retries resolve the same accepted snapshot rather than reread changed conversation history.

The upstream agent must treat supplied history as authoritative. Appending it to a separately accumulated session transcript would duplicate context. The application does not provide a separate incremental agent-session protocol.

## Attached messages

A user message with attachments uses standard content parts:

1. A `text` part containing the actual user message, or an empty string for attachment-only messages.
2. Expanded attachments in selection order.
3. Within each attachment, sections in source order where known.

Pages, images, sheets, and entries remain parts of that user message; they are not new conversational turns. Assistant responses remain strings.

Extracted text and image captions use this small application convention inside a standard `text` part:

```text
Attachment: <JSON-quoted filename>
[Entry: <JSON-quoted relative path>]
[Part: <JSON-quoted section label>]
[Notice: <JSON-quoted material limitation>]
[additional Notice lines]

<payload>
```

Brackets indicate optional lines and are not transmitted. Header lines appear in the order shown. `Attachment` is required; `Entry` identifies a container member; `Part` identifies a source section; `Notice` describes a meaningful omission or limitation. Values use JSON string quoting so filenames and labels cannot introduce extra header lines. Duplicate notices within a header are collapsed.

The first blank line ends the header. Everything following it is source payload, even if it contains header-like text. The header is not added to ordinary user messages. It is an application convention, not an OpenAI-defined field or metadata object.

Example:

```text
Attachment: "report.pdf"
Part: "Page 4"
Notice: "Only the first 100 of 120 pages were included."

Actual extracted text from page 4...
```

## Image and native PDF inputs

Images use `image_url: {url: "data:<actual-image-MIME>;base64,...", detail: "auto"}` with the configured detail level. A header/caption text part immediately precedes each image. If that section already has extracted text, its header and text serve as the caption; additional image-specific notices can require a separate caption.

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Summarize this report."},
    {"type": "text", "text": "Attachment: \"report.pdf\"\nPart: \"Page 1\"\n\nActual page text..."},
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,...", "detail": "auto"}}
  ]
}
```

Native PDF input is used only when both vision and native PDF support are configured. It uses the standard `file` part:

```json
{
  "type": "file",
  "file": {
    "filename": "report.pdf",
    "file_data": "data:application/pdf;base64,..."
  }
}
```

Its filename already identifies the file, so a redundant caption is unnecessary. Native transmission uses original bytes rather than additionally sending the entire local extraction. Local extraction limits do not describe the provider's native processing coverage.

New PDF uploads are normalized independently of the model selected at upload. The same stored upload can therefore use normalized or native transport. Capability differences do not change conversation ownership or history policy.

Private application upload URLs are resolved by the server and never sent upstream. Storage IDs, ownership, extraction version, internal blocks, coverage metadata, and diagnostic fields remain internal to the application. Original bytes are sent only when required for a native file or supported original image. Material coverage warnings appear as readable notices. UI metadata and draft responses expose coverage without duplicating extracted block payloads or internal EPUB links.

## Supported format families

| Family | Formats | Payload and boundaries |
| --- | --- | --- |
| Text and structured text | TXT/TEXT, MD/MARKDOWN, JSON, YAML/YML, XML; supported source/config/log/diff extensions and Dockerfile, Makefile, `.env`, `.gitignore` | Decoded text with preserved indentation and line breaks. TXT and Markdown use the same path. Source is not executed or transformed into an application-specific object. |
| Records | JSONL/NDJSON | Original decoded records and blank lines, including original line endings. Invalid records remain raw with a source-line notice. No inserted record-number prefixes. |
| Tables | CSV, TSV, XLS, XLSX, ODS | CSV/TSV source text or CSV text per workbook sheet, labelled `Sheet: <name>`. Correct quoting and meaningful empty row positions. Stored formula values are used; no promise of formula evaluation. Missing cached results are disclosed. |
| Documents | PDF, DOC/DOCX, ODT, RTF | Text and images paired per page, or native PDF when configured. Converted Office pages are labelled `Converted page N`. Scanned pages can contain an image without text; OCR is not implied. |
| Presentations | PPT/PPTX/ODP | Text/images per slide in order. PPTX speaker notes are separate `Slide N — speaker notes` sections. Other presentation formats disclose that speaker notes are not extracted. Output is static, not animation/video playback. |
| Images | JPEG/PNG/WebP/GIF, HEIC/HEIF, TIFF, BMP, SVG | Supported/converted image inputs; source filename preserved. Orientation corrected, unsupported encodings rasterized, SVG safely rendered. Frame selection is disclosed when frames are omitted. |
| Web documents and books | HTML/HTM, EPUB | HTML becomes readable text. EPUB spine order supplies chapter text and known chapter/image associations. Unassociated supported images follow as labelled embedded images. Missing chapter/image sources and unsupported external/inline image references are disclosed. External resources are not fetched. |
| Email | EML | Separate `Email headers` and `Email body` sections. Supported attachments use `Entry` and the same format rules as standalone files. Remote images are not fetched. |
| Collections | ZIP, TAR, TAR.GZ/TGZ, GZ | Supported entries become separate sections with `Entry` paths. TAR.GZ is decompressed then expanded; ordinary GZ has a single decompressed child. Duplicate names get occurrence labels. Unsupported, failed, nested, or limit-excluded entries have explicit notices. |

Source/config extensions include PY; JS/MJS/CJS/TS/TSX/JSX; JAVA; C/H/CPP/HPP; CS/GO/RS; SH/BASH; SQL/CSS; TOML/INI/CONF/PROPERTIES; LOG/DIFF/PATCH. The shared `/api/uploads/formats` registry remains authoritative for accepted formats and MIME aliases.

Section numbers are one-based. Labels describe available evidence: converted document pagination is distinct from original pagination, and unknown EPUB image associations are not invented. Large CSV/JSONL payloads are cut at complete record boundaries. Ordinary text truncation avoids splitting UTF-16 surrogate pairs. Notices are outside payloads so they do not corrupt CSV or JSONL.

The original file remains downloadable. Normalized CSV is not a lossless workbook representation; document extraction is not a lossless representation of all formatting, annotations, formulas, media, or interactive features. No new formats or OCR engine are introduced by this transport change.

## Machine parsing

- Read roles and ordering from `messages`.
- String content is ordinary conversation text.
- For an attached user message, the first text part is the user's text; subsequent parts are attachments.
- Parse only the header of attachment text/caption parts, ending at the first blank line. Decode its values as JSON strings.
- The following image belongs to the preceding caption/section. Preserve content-part order.
- Native files use standard `file` fields.
- Do not inspect ordinary prose or source payloads for embedded metadata.

This provides reliable payload boundaries without globally unique upstream attachment identifiers or a lossless document object model. It adds no schema prompt to plain chat.

## Limits, failures, and responses

The existing upload, conversion, expansion, image, text, file-count, and serialized-request limits apply to the entire replayed request. Usable partial extraction has notices; invalid conversions and inputs that cannot yield usable content fail explicitly. Missing historical uploads, inconsistent image references, and unsupported backend capabilities fail explicitly. Images are not silently removed for a text-only backend, and oversized history is not silently trimmed or summarized.

Standard Chat Completions SSE text is stored without wrappers. Refusal, malformed output, unsupported tool calls, and other unsupported response shapes retain their existing explicit failure handling. An upstream agent may execute its own tools and return text; application-side tool execution is outside this contract.

## Upgrade behavior

- Remove `history_mode: latest_only` from model configuration; it is rejected with a migration error. Legacy `history_mode: full` is accepted and normalized away. There is no alternative history mode.
- Update upstream agents to consume authoritative full history before enabling them.
- Coordinate deployment across replicas. The runtime configuration revision now includes the request-contract version, fencing older serializers when the new configuration is activated. Finish in-flight work before replacement where possible; do not manually reactivate configuration from an old replica.
- Queued/recovered jobs created with the previous request format fail with a resubmission message. Their captured input is not silently rewritten or expanded into a potentially different history.
- Existing stored conversations and uploads remain usable. Legacy uploads retain their existing extraction and labels; the transport does not guess section boundaries by parsing marker-looking source text. Reupload to obtain new section-aware extraction.
- Older native-only PDFs still need reuploading for normalized transport. New uploads retain normalized content regardless of the initially selected model.
- No database schema migration, dependency change, or provider Files API cache is required.

## Verification

The browser-facing response stream sends an SSE keep-alive comment every 15 seconds while a generation runs. A disconnected accepted stream recovers through the saved generation status and polling, without submitting another model request. Terminal events end stream consumption immediately, so a later socket failure cannot overwrite the saved result. Provider failures and user cancellation remain distinct from connection interruptions.

Regression checks include a generated 250-page PDF sent to a delayed hardcoded mock, idle keep-alives and their cleanup, browser `error in input stream` recovery for Send and Regenerate, and preservation of saved provider failures. Rendered PDF coverage remains the first 100 pages with an explicit warning.

Checks cover plain-message passthrough and metadata-looking user text; full history and optional instructions; page/image pairing and private-field exclusion; legacy/empty text files; quoted headers; record-safe truncation; workbook row positions and formula notices; container omissions and duplicate entry names; and MIME/native PDF handling.

PostgreSQL-backed integration uses a local mock provider to verify actual request bodies, including fresh uploads, edits, regeneration, follow-up history, interrupted-answer exclusion, old-job rejection, and request-contract fencing. Real converter fixtures exercise Office formats, PDF pages, EPUB/collection images, BMP/TIFF/HEIC/SVG using the production converter environment with current source mounted. Frontend checks cover compilation, existing unit tests, and production build. These checks do not contact a live model provider.
