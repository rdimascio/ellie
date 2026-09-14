# Local document extraction

`@ellie/life-ingest` converts uploaded sources into bounded local text. It performs no network requests and does not execute document content.

```ts
import { extractDocument } from "@ellie/life-ingest";

const result = await extractDocument({ filename, mimeType, bytes }, { signal });
```

The function returns `Promise<{ text: string; metadata?: Record<string, unknown> }>`.

UTF-8 plain text, Markdown, HTML, RFC 822 email, JSON, and CSV are handled directly. HTML scripts, styles, templates, and markup are removed. On macOS, PDF, PNG, and JPEG use the checked-in Swift helper with PDFKit, Vision, ImageIO, and AppKit. PDFs use embedded text first and OCR only pages without text. Extracted PDF text contains `[Page N]` markers and metadata includes page references and the extraction method.

Limits are 50 MB input, 5 MB extracted text, 100 PDF pages, 40 megapixels per raster image, and 30 seconds for native extraction. Native work runs in a child process with `shell: false`; its private temporary directory is mode `0700`, the input file is `0600`, and cleanup runs after success, failure, timeout, or cancellation. An `AbortSignal` cancels the retained child process.

PDF and image extraction currently requires macOS. Other platforms receive an explicit error. Unsupported, corrupt, oversized, timed-out, and cancelled sources do not produce placeholder text.

The life service can adapt the asynchronous result to `LifeStore.ingestSource` and use `metadata.pages` to create cited chunks. The existing synchronous `BinaryExtractor` interface should not block the event loop by spawning the native helper directly.
