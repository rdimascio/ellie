import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_INPUT = 50 * 1024 * 1024;
const MAX_TEXT = 5 * 1024 * 1024;
const DEADLINE_MS = 30_000;
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "message/rfc822",
  "application/json",
  "text/csv",
]);
const NATIVE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

export interface ExtractDocumentInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface ExtractDocumentOptions {
  signal?: AbortSignal;
}
export interface ExtractedDocument {
  text: string;
  metadata?: Record<string, unknown>;
}
export class DocumentExtractionError extends Error {
  override name = "DocumentExtractionError";
}

function safeName(value: string) {
  const name = [...basename(value)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, 180);
  return name || "document";
}
function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentExtractionError("The document is not valid UTF-8 text.");
  }
}
function cleanText(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("").trim();
  if (Buffer.byteLength(normalized) > MAX_TEXT)
    throw new DocumentExtractionError("Extracted text exceeds the 5 MB limit.");
  return normalized;
}
function htmlToText(html: string) {
  const withoutActive = html.replace(
    /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  return cleanText(
    withoutActive
      .replace(/<(br|\/p|\/div|\/li|\/tr|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n"),
  );
}
function emailToText(raw: string) {
  const split = raw.search(/\r?\n\r?\n/),
    headers = split < 0 ? "" : raw.slice(0, split),
    body = split < 0 ? raw : raw.slice(split).trim();
  const useful = ["From", "To", "Cc", "Date", "Subject"].flatMap((name) => {
    const match = headers.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, "im"));
    return match?.[1] ? [`${name}: ${match[1].replace(/\r?\n[ \t]+/g, " ")}`] : [];
  });
  const contentType = headers.match(/^Content-Type:\s*([^;\r\n]+)/im)?.[1]?.toLowerCase();
  return cleanText(
    [...useful, "", contentType === "text/html" ? htmlToText(body) : body].join("\n"),
  );
}
function inferredMime(input: ExtractDocumentInput) {
  const provided = input.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (provided) return provided;
  const ext = extname(input.filename).toLowerCase();
  return (
    (
      {
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".html": "text/html",
        ".htm": "text/html",
        ".eml": "message/rfc822",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
      } as Record<string, string>
    )[ext] ?? "application/octet-stream"
  );
}

async function nativeExtract(
  input: ExtractDocumentInput,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  if (process.platform !== "darwin")
    throw new DocumentExtractionError("PDF and image extraction currently requires macOS.");
  if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");
  const dir = await mkdtemp(join(tmpdir(), "ellie-extract-"));
  await chmod(dir, 0o700);
  const source = join(dir, `input${extname(safeName(input.filename)).slice(0, 12)}`),
    output = join(dir, "output.json");
  let child: ChildProcess | undefined,
    timer: NodeJS.Timeout | undefined,
    reapTimer: NodeJS.Timeout | undefined,
    abort: (() => void) | undefined,
    reaped = false;
  try {
    await writeFile(source, input.bytes, { mode: 0o600 });
    if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");
    const script = fileURLToPath(new URL("../native/ExtractDocument.swift", import.meta.url));
    await new Promise<void>((resolve, reject) => {
      child = spawn("/usr/bin/xcrun", ["swift", script, source, output, inferredMime(input)], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostic = "";
      let terminalError: Error | undefined;
      child.stderr?.on("data", (chunk) => {
        if (diagnostic.length < 4096) diagnostic += String(chunk);
      });
      const stop = (error: Error) => {
        terminalError ??= error;
        if (child?.exitCode === null && !child.killed) child.kill("SIGKILL");
        reapTimer ??= setTimeout(() => {
          reject(
            new DocumentExtractionError(
              "Document extraction stopped, but process cleanup is still pending; private scratch files were preserved.",
            ),
          );
        }, 2_000);
      };
      timer = setTimeout(
        () => stop(new DocumentExtractionError("Document extraction timed out after 30 seconds.")),
        DEADLINE_MS,
      );
      abort = () => stop(new DOMException("Extraction cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", () =>
        stop(new DocumentExtractionError("The macOS document extractor could not start.")),
      );
      child.once("close", (code) => {
        reaped = true;
        if (reapTimer) clearTimeout(reapTimer);
        if (terminalError) reject(terminalError);
        else if (code === 0) resolve();
        else
          reject(
            new DocumentExtractionError(
              diagnostic.trim().split("\n").at(-1)?.slice(0, 300) ||
                "The document could not be read.",
            ),
          );
      });
    });
    const outputInfo = await stat(output);
    if (outputInfo.size > MAX_TEXT + 1_000_000)
      throw new DocumentExtractionError("Extracted output exceeds the allowed limit.");
    const raw = await readFile(output, "utf8");
    const value = JSON.parse(raw) as {
      text?: unknown;
      pages?: unknown;
      pageCount?: unknown;
      method?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof value.text !== "string")
      throw new DocumentExtractionError("The document extractor returned invalid output.");
    const extracted = cleanText(value.text);
    if (!extracted.replace(/\[Page \d+\]/g, "").trim())
      throw new DocumentExtractionError("No readable text was found in the document.");
    const metadata: Record<string, unknown> = {};
    for (const key of ["method", "pageCount", "pages", "width", "height"] as const)
      if (value[key] !== undefined) metadata[key] = value[key];
    return {
      text: extracted,
      metadata,
    };
  } catch (error) {
    if (
      error instanceof DocumentExtractionError ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw error;
    throw new DocumentExtractionError("The document is corrupt or could not be extracted.");
  } finally {
    if (timer) clearTimeout(timer);
    if (reapTimer) clearTimeout(reapTimer);
    if (abort) signal?.removeEventListener("abort", abort);
    if (!child || reaped) await rm(dir, { recursive: true, force: true });
  }
}

export async function extractDocument(
  input: ExtractDocumentInput,
  options: ExtractDocumentOptions = {},
): Promise<ExtractedDocument> {
  if (
    !input ||
    typeof input.filename !== "string" ||
    typeof input.mimeType !== "string" ||
    !(input.bytes instanceof Uint8Array)
  )
    throw new TypeError("extractDocument requires a filename, MIME type, and Uint8Array bytes.");
  if (input.bytes.byteLength === 0)
    throw new DocumentExtractionError("The uploaded document is empty.");
  if (input.bytes.byteLength > MAX_INPUT)
    throw new DocumentExtractionError("The uploaded document exceeds the 50 MB limit.");
  if (options.signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");
  const mime = inferredMime(input);
  if (TEXT_TYPES.has(mime)) {
    const raw = decode(input.bytes);
    const text =
      mime === "text/html"
        ? htmlToText(raw)
        : mime === "message/rfc822"
          ? emailToText(raw)
          : cleanText(raw);
    return { text, metadata: { method: "text", mimeType: mime } };
  }
  if (NATIVE_TYPES.has(mime))
    return nativeExtract(
      { ...input, filename: safeName(input.filename), mimeType: mime },
      options.signal,
    );
  throw new DocumentExtractionError(
    `Unsupported document type: ${mime || "unknown"}. Use text, Markdown, HTML, email, PDF, PNG, or JPEG.`,
  );
}
