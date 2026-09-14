import { crc32, inflateRawSync } from "node:zlib";

const MAX_ENTRIES = 2_048;
const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_ENTRY = 20 * 1024 * 1024;
const MAX_RATIO = 100;
const MAX_XML = 20 * 1024 * 1024;
const DEADLINE_MS = 10_000;

export class DocxError extends Error {}

type Entry = {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  flags: number;
  crc: number;
};

const u16 = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
const u32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)) >>>
  0;

function safeEntryName(name: string) {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === ".." || part === ".") ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new DocxError("The DOCX contains an unsafe ZIP entry path.");
}

function entries(bytes: Uint8Array, signal?: AbortSignal): Map<string, Entry> {
  const started = Date.now();
  let end = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset++)
    if (u32(bytes, offset) === 0x06054b50) end = offset;
  if (end < 0) throw new DocxError("The DOCX ZIP directory is missing or truncated.");
  const count = u16(bytes, end + 10);
  if (
    u16(bytes, end + 4) !== 0 ||
    u16(bytes, end + 6) !== 0 ||
    u16(bytes, end + 8) !== count ||
    end + 22 + u16(bytes, end + 20) !== bytes.length
  )
    throw new DocxError("Multi-disk or trailing-data ZIP files are not supported.");
  const directorySize = u32(bytes, end + 12);
  const directoryOffset = u32(bytes, end + 16);
  if (count < 1 || count > MAX_ENTRIES)
    throw new DocxError(`The DOCX contains too many ZIP entries (limit ${MAX_ENTRIES}).`);
  if (directoryOffset + directorySize > end)
    throw new DocxError("The DOCX ZIP directory is corrupt.");
  const result = new Map<string, Entry>();
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");
    if (Date.now() - started > DEADLINE_MS) throw new DocxError("DOCX extraction timed out.");
    if (cursor + 46 > end || u32(bytes, cursor) !== 0x02014b50)
      throw new DocxError("The DOCX ZIP directory is corrupt.");
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const compressed = u32(bytes, cursor + 20);
    const uncompressed = u32(bytes, cursor + 24);
    const crc = u32(bytes, cursor + 16);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const offset = u32(bytes, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 0x41) throw new DocxError("Encrypted DOCX files are not supported.");
    if (u16(bytes, cursor + 34) !== 0)
      throw new DocxError("Multi-disk DOCX ZIP entries are not supported.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    safeEntryName(name);
    if (result.has(name)) throw new DocxError("The DOCX contains duplicate ZIP entries.");
    if (![0, 8].includes(method)) throw new DocxError("The DOCX uses unsupported ZIP compression.");
    if (uncompressed > MAX_ENTRY) throw new DocxError("A DOCX entry exceeds the 20 MB limit.");
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED)
      throw new DocxError("The expanded DOCX exceeds the 100 MB limit.");
    if (uncompressed > 1_000_000 && uncompressed > Math.max(1, compressed) * MAX_RATIO)
      throw new DocxError("The DOCX compression ratio is unsafe.");
    result.set(name, { name, method, compressed, uncompressed, offset, flags, crc });
    cursor = next;
  }
  if (cursor !== directoryOffset + directorySize)
    throw new DocxError("The DOCX ZIP directory size is inconsistent.");
  return result;
}

function content(bytes: Uint8Array, entry: Entry): Uint8Array {
  if (entry.offset + 30 > bytes.length || u32(bytes, entry.offset) !== 0x04034b50)
    throw new DocxError("The DOCX contains a corrupt ZIP entry.");
  const nameLength = u16(bytes, entry.offset + 26);
  const extraLength = u16(bytes, entry.offset + 28);
  const localFlags = u16(bytes, entry.offset + 6);
  const localMethod = u16(bytes, entry.offset + 8);
  const localName = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(entry.offset + 30, entry.offset + 30 + nameLength),
  );
  if (localName !== entry.name || localFlags !== entry.flags || localMethod !== entry.method)
    throw new DocxError("The DOCX ZIP local header is inconsistent.");
  if (
    !(entry.flags & 8) &&
    (u32(bytes, entry.offset + 18) !== entry.compressed ||
      u32(bytes, entry.offset + 22) !== entry.uncompressed)
  )
    throw new DocxError("The DOCX ZIP local entry sizes are inconsistent.");
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressed;
  if (end > bytes.length) throw new DocxError("The DOCX contains a truncated ZIP entry.");
  const raw = bytes.subarray(start, end);
  let output: Uint8Array;
  try {
    output =
      entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: entry.uncompressed });
  } catch {
    throw new DocxError("The DOCX contains invalid compressed data.");
  }
  if (output.byteLength !== entry.uncompressed)
    throw new DocxError("The DOCX ZIP entry size is inconsistent.");
  if (crc32(output) !== entry.crc) throw new DocxError("The DOCX ZIP entry checksum is invalid.");
  return output;
}

function entityText(value: string) {
  const recognized = /&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g;
  if (value.replace(recognized, "").includes("&"))
    throw new DocxError("The DOCX XML contains an invalid entity.");
  const decoded = value.replace(recognized, (_whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.toLowerCase().startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!xmlCharacter(code)) throw new DocxError("The DOCX XML contains an invalid character.");
    return String.fromCodePoint(code);
  });
  validateXmlCharacters(decoded);
  return decoded;
}

function xmlCharacter(code: number) {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function validateXmlCharacters(value: string) {
  for (const character of value)
    if (!xmlCharacter(character.codePointAt(0)!))
      throw new DocxError("The DOCX XML contains an invalid character.");
}

const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

function parseDocument(xml: string, check: () => void) {
  type Element = { name: string; local: string; uri?: string; namespaces: Map<string, string> };
  const stack: Element[] = [];
  const output: string[] = [];
  const references: Array<{ reference: string; kind: "heading" | "paragraph" | "table-row" }> = [];
  let cursor = 0;
  let nodes = 0;
  let textBytes = 0;
  let paragraphNumber = 0;
  let tableNumber = 0;
  let rowNumber = 0;
  let tableDepth = 0;
  let rootSeen = false;
  let topLevelCount = 0;
  let paragraph: { text: string; heading?: number; inCell: boolean } | undefined;
  let cells: string[] | undefined;
  let cell: string | undefined;
  const resolve = (prefix: string) => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const value = stack[index]!.namespaces.get(prefix);
      if (value !== undefined) return value;
    }
  };
  const addText = (value: string, entities = true) => {
    const text = (entities ? entityText(value) : value).replace(/[\t\r\n ]+/g, " ");
    textBytes += Buffer.byteLength(text);
    if (textBytes > MAX_XML) throw new DocxError("The DOCX contains too much text.");
    if (paragraph) paragraph.text += text;
  };
  const finalize = (element: Element) => {
    if (!WORD_NAMESPACES.has(element.uri ?? "")) return;
    if (element.local === "p" && paragraph) {
      const text = paragraph.text.trim();
      if (paragraph.inCell) {
        if (text) cell = `${cell ?? ""}${cell ? " " : ""}${text}`;
      } else if (text) {
        paragraphNumber++;
        const reference = paragraph.heading
          ? `Heading ${paragraphNumber}`
          : `Paragraph ${paragraphNumber}`;
        output.push(
          `[${reference}]\n${paragraph.heading ? `${"#".repeat(paragraph.heading)} ` : ""}${text}`,
        );
        references.push({ reference, kind: paragraph.heading ? "heading" : "paragraph" });
      }
      paragraph = undefined;
    } else if (element.local === "tc") {
      if (cell?.trim()) cells?.push(cell.trim());
      cell = undefined;
    } else if (element.local === "tr") {
      rowNumber++;
      if (cells?.length) {
        const reference = `Table ${tableNumber}, row ${rowNumber}`;
        output.push(`[${reference}]\n${cells.join(" | ")}`);
        references.push({ reference, kind: "table-row" });
      }
      cells = undefined;
    } else if (element.local === "tbl") tableDepth--;
  };
  while (cursor < xml.length) {
    check();
    const open = xml.indexOf("<", cursor);
    if (open < 0) {
      if (xml.slice(cursor).trim()) throw new DocxError("The DOCX XML is malformed.");
      cursor = xml.length;
      break;
    }
    if (open > cursor) {
      const between = xml.slice(cursor, open);
      if (stack.at(-1)?.local === "t" && WORD_NAMESPACES.has(stack.at(-1)?.uri ?? ""))
        addText(between);
      else if (between.includes("&")) entityText(between);
      if (!stack.length && between.trim())
        throw new DocxError("Text appears outside the DOCX XML root.");
    }
    if (xml.startsWith("<!--", open)) {
      const close = xml.indexOf("-->", open + 4);
      if (close < 0) throw new DocxError("The DOCX XML comment is truncated.");
      if (xml.slice(open + 4, close).includes("--"))
        throw new DocxError("The DOCX XML comment is malformed.");
      cursor = close + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const close = xml.indexOf("?>", open + 2);
      if (close < 0) throw new DocxError("The DOCX XML declaration is truncated.");
      cursor = close + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const close = xml.indexOf("]]>", open + 9);
      if (close < 0) throw new DocxError("The DOCX XML CDATA section is truncated.");
      const cdata = xml.slice(open + 9, close);
      validateXmlCharacters(cdata);
      if (!stack.length && cdata.trim())
        throw new DocxError("CDATA appears outside the DOCX XML root.");
      if (stack.at(-1)?.local === "t" && WORD_NAMESPACES.has(stack.at(-1)?.uri ?? ""))
        addText(cdata, false);
      cursor = close + 3;
      continue;
    }
    if (xml.startsWith("<!", open)) throw new DocxError("Unsupported DOCX XML declaration.");
    let end = open + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const character = xml[end]!;
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end >= xml.length || quote) throw new DocxError("The DOCX XML tag is truncated.");
    if (end - open > 65_536) throw new DocxError("A DOCX XML tag exceeds the safe limit.");
    let tag = xml.slice(open + 1, end).trim();
    cursor = end + 1;
    if (!tag) throw new DocxError("The DOCX XML contains an empty tag.");
    const closing = tag.startsWith("/");
    const selfClosing = !closing && tag.endsWith("/");
    if (closing) tag = tag.slice(1).trim();
    if (selfClosing) tag = tag.slice(0, -1).trim();
    const nameMatch = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s|$)/.exec(tag);
    if (!nameMatch) throw new DocxError("The DOCX XML tag name is invalid.");
    const name = nameMatch[1]!;
    if (closing) {
      if (tag !== name || stack.at(-1)?.name !== name)
        throw new DocxError("The DOCX XML element nesting is invalid.");
      const element = stack.pop()!;
      finalize(element);
      continue;
    }
    const attributes = new Map<string, string>();
    const namespaces = new Map<string, string>();
    let rest = tag.slice(name.length);
    let attributeCount = 0;
    while (rest.trim()) {
      if (++attributeCount > 256) throw new DocxError("A DOCX XML tag has too many attributes.");
      if (!/^\s/.test(rest)) throw new DocxError("DOCX XML attributes require whitespace.");
      rest = rest.trimStart();
      const attribute = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*(["'])([\s\S]*?)\2/.exec(
        rest,
      );
      if (!attribute) throw new DocxError("The DOCX XML attribute is malformed.");
      if (attributes.has(attribute[1]!)) throw new DocxError("The DOCX XML repeats an attribute.");
      if (attribute[3]!.includes("<")) throw new DocxError("The DOCX XML attribute is malformed.");
      const value = entityText(attribute[3]!);
      attributes.set(attribute[1]!, value);
      if (attribute[1] === "xmlns") namespaces.set("", value);
      else if (attribute[1]!.startsWith("xmlns:")) namespaces.set(attribute[1]!.slice(6), value);
      rest = rest.slice(attribute[0].length);
    }
    const [prefix, local] = name.includes(":") ? name.split(":", 2) : ["", name];
    const uri = namespaces.get(prefix!) ?? resolve(prefix!);
    const element: Element = { name, local: local!, uri, namespaces };
    if (!stack.length) {
      topLevelCount++;
      if (topLevelCount !== 1 || local !== "document" || !WORD_NAMESPACES.has(uri ?? ""))
        throw new DocxError("The DOCX must have one Word document root.");
    }
    if (++nodes > 100_000 || stack.length >= 256)
      throw new DocxError("The DOCX XML structure exceeds safe limits.");
    stack.push(element);
    if (WORD_NAMESPACES.has(uri ?? "")) {
      if (local === "document" && stack.length !== 1)
        throw new DocxError("The DOCX document root is invalid.");
      else if (local === "document") {
        if (rootSeen) throw new DocxError("The DOCX contains multiple document roots.");
        rootSeen = true;
      } else if (local === "tbl") {
        if (tableDepth) throw new DocxError("Nested DOCX tables are not supported.");
        tableDepth++;
        tableNumber++;
        rowNumber = 0;
      } else if (local === "tr") cells = [];
      else if (local === "tc") cell = "";
      else if (local === "p") paragraph = { text: "", inCell: tableDepth > 0 };
      else if (local === "pStyle" && paragraph) {
        const style = attributes.get(`${prefix}:val`) ?? attributes.get("val") ?? "";
        const heading = /^(?:Heading|Title)(\d*)$/i.exec(style);
        if (heading) paragraph.heading = Math.min(6, Math.max(1, Number(heading[1] || 1)));
      } else if ((local === "tab" || local === "br") && paragraph) paragraph.text += " ";
    }
    if (selfClosing) {
      finalize(stack.pop()!);
    }
  }
  if (stack.length) throw new DocxError("The DOCX XML is truncated.");
  if (!rootSeen) throw new DocxError("The DOCX document root is invalid.");
  if (!output.length) return { text: "", references };
  return { text: output.join("\n\n").trim(), references };
}

export function extractDocx(bytes: Uint8Array, signal?: AbortSignal) {
  const started = Date.now();
  const check = () => {
    if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");
    if (Date.now() - started > DEADLINE_MS) throw new DocxError("DOCX extraction timed out.");
  };
  const archive = entries(bytes, signal);
  if ([...archive.keys()].some((name) => /(^|\/)vbaProject\.bin$/i.test(name)))
    throw new DocxError("Macro-enabled documents are not accepted. Save a macro-free DOCX.");
  const relationships = [...archive.keys()].filter((name) => name.endsWith(".rels"));
  let hasExternalRelationships = false;
  for (const name of relationships) {
    check();
    const xml = new TextDecoder().decode(content(bytes, archive.get(name)!));
    if (/TargetMode\s*=\s*["']External["']/i.test(xml)) hasExternalRelationships = true;
  }
  const document = archive.get("word/document.xml");
  if (!document) throw new DocxError("The DOCX does not contain word/document.xml.");
  if (document.uncompressed > MAX_XML) throw new DocxError("The DOCX document XML is too large.");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(content(bytes, document));
  check();
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new DocxError("DOCX files with DTD or entity declarations are not accepted.");
  const parsed = parseDocument(xml, check);
  const text = parsed.text;
  const hasEmbeddedMedia = [...archive.keys()].some((name) => name.startsWith("word/media/"));
  if (!text)
    throw new DocxError(
      hasEmbeddedMedia
        ? "No readable document text was found. Embedded DOCX images are not OCRed."
        : "No readable paragraphs or table cells were found in the DOCX.",
    );
  return {
    text,
    metadata: {
      method: "docx",
      references: parsed.references.slice(0, 1_000),
      referenceCount: parsed.references.length,
      referencesTruncated: parsed.references.length > 1_000,
      hasEmbeddedMedia,
      hasExternalRelationships,
      limitations: [
        "Embedded images and objects are not extracted or OCRed.",
        "Headers, footers, comments, footnotes, and revision history are not included.",
        ...(hasExternalRelationships
          ? ["External hyperlinks and resources are not fetched; visible link text is retained."]
          : []),
      ],
    },
  };
}
