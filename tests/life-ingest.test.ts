import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { extractDocument, DocumentExtractionError } from "../packages/life-ingest/src/index.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

function makeZip(
  files: Array<{ name: string; content: string; uncompressed?: number }>,
): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const content = Buffer.from(file.content);
    const size = file.uncompressed ?? content.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(crc32(content), 14);
    local.push(header, name, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(crc32(content), 16);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("extracts DOCX headings, paragraphs, and table rows with references", async () => {
  const docx = makeZip([
    {
      name: "word/document.xml",
      content: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Garden plan</w:t></w:r></w:p>
        <w:p><w:r><w:t>Plant tomatoes &amp; basil.</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Bed</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Crop</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
    },
  ]);
  const result = await extractDocument({
    filename: "garden.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: docx,
  });
  assert.match(result.text, /\[Heading 1\]\n# Garden plan/);
  assert.match(result.text, /\[Paragraph 2\]\nPlant tomatoes & basil/);
  assert.match(result.text, /\[Table 1, row 1\]\nBed \| Crop/);
  assert.ok(result.metadata);
  assert.deepEqual(
    (result.metadata.references as Array<{ reference: string }>).map((item) => item.reference),
    ["Heading 1", "Paragraph 2", "Table 1, row 1"],
  );
  assert.match(String((result.metadata.limitations as string[])[0]), /not extracted or OCRed/);
  const strictNamespace = await extractDocument({
    filename: "strict.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: makeZip([
      {
        name: "word/document.xml",
        content: `<x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:body><x:p><x:r><x:t>Strict namespace text</x:t></x:r></x:p></x:body></x:document>`,
      },
    ]),
  });
  assert.match(strictNamespace.text, /Strict namespace text/);
});

test("rejects unsafe, bomb-like, truncated, and active DOCX content", async () => {
  const mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  await assert.rejects(
    extractDocument({ filename: "broken.docx", mimeType, bytes: bytes("PK truncated") }),
    /missing or truncated/,
  );
  await assert.rejects(
    extractDocument({
      filename: "bomb.docx",
      mimeType,
      bytes: makeZip([
        {
          name: "word/document.xml",
          content: "<w:document/>",
          uncompressed: 2_000_000,
        },
      ]),
    }),
    /compression ratio/,
  );
  const linked = await extractDocument({
    filename: "external.docx",
    mimeType,
    bytes: makeZip([
      {
        name: "word/document.xml",
        content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Visible link text</w:t></w:r></w:p></w:body></w:document>`,
      },
      {
        name: "word/_rels/document.xml.rels",
        content: `<Relationships><Relationship TargetMode="External" Target="https://example.test/private"/></Relationships>`,
      },
    ]),
  });
  assert.match(linked.text, /Visible link text/);
  assert.ok(linked.metadata);
  assert.equal(linked.metadata.hasExternalRelationships, true);
  assert.match(String((linked.metadata.limitations as string[]).at(-1)), /not fetched/);
  await assert.rejects(
    extractDocument({
      filename: "entity.docx",
      mimeType,
      bytes: makeZip([
        {
          name: "word/document.xml",
          content: `<!DOCTYPE x [<!ENTITY steal SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>&steal;</w:t></w:r></w:p></w:document>`,
        },
      ]),
    }),
    /DTD or entity/,
  );
  await assert.rejects(
    extractDocument({
      filename: "macro.docx",
      mimeType,
      bytes: makeZip([
        {
          name: "word/document.xml",
          content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        },
        { name: "word/vbaProject.bin", content: "macro" },
      ]),
    }),
    /Macro-enabled/,
  );
  await assert.rejects(
    extractDocument({
      filename: "path.docx",
      mimeType,
      bytes: makeZip([{ name: "../word/document.xml", content: "<w:document/>" }]),
    }),
    /unsafe ZIP entry path/,
  );
  await assert.rejects(
    extractDocument({
      filename: "image-only.docx",
      mimeType,
      bytes: makeZip([
        {
          name: "word/document.xml",
          content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        },
        { name: "word/media/image1.png", content: "image bytes" },
      ]),
    }),
    /images are not OCRed/,
  );
  const manyOpen = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${"<w:p>".repeat(50_000)}`;
  const started = performance.now();
  await assert.rejects(
    extractDocument({
      filename: "many-open.docx",
      mimeType,
      bytes: makeZip([{ name: "word/document.xml", content: manyOpen }]),
    }),
    /structure exceeds|truncated/,
  );
  assert.ok(performance.now() - started < 2_000, "malformed XML is rejected within a bound");
});

test("enforces Word namespaces, one root, XML entities, characters, and attribute boundaries", async () => {
  const mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const wrap = (xml: string) =>
    extractDocument({
      filename: "strict.docx",
      mimeType,
      bytes: makeZip([{ name: "word/document.xml", content: xml }]),
    });
  const namespaceFiltered = await wrap(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:fake="urn:not-word"><w:body><w:p><w:r><w:t>Kept</w:t><fake:t>Not kept</fake:t></w:r></w:p></w:body></w:document>`,
  );
  assert.match(namespaceFiltered.text, /Kept/);
  assert.doesNotMatch(namespaceFiltered.text, /Not kept/);
  const escapedAttribute = await wrap(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" example="&lt;"><w:body><w:p><w:r><w:t>Valid attribute</w:t></w:r></w:p></w:body></w:document>`,
  );
  assert.match(escapedAttribute.text, /Valid attribute/);
  for (const [xml, expected] of [
    [
      `<other xmlns="urn:other"/><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      /one Word document root/,
    ],
    [
      `<![CDATA[outside]]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      /CDATA appears outside/,
    ],
    [
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>&AMP;</w:t></w:r></w:p></w:document>`,
      /invalid entity/,
    ],
    [
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>&#0;</w:t></w:r></w:p></w:document>`,
      /invalid character/,
    ],
    [
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>&#xD800;</w:t></w:r></w:p></w:document>`,
      /invalid character/,
    ],
    [
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"example="bad"/>`,
      /require whitespace/,
    ],
    [
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" example="raw<value"/>`,
      /attribute is malformed/,
    ],
  ] as const)
    await assert.rejects(wrap(xml), expected);
});

test("extracts useful text formats without treating active HTML as content", async () => {
  const markdown = await extractDocument({
    filename: "notes.md",
    mimeType: "text/markdown",
    bytes: bytes("# Packing\n\nBring a hat."),
  });
  assert.equal(markdown.text, "# Packing\n\nBring a hat.");
  const html = await extractDocument({
    filename: "page.html",
    mimeType: "text/html",
    bytes: bytes(
      "<h1>Policy</h1><script>steal()</script><p>Doors close at 6 &amp; reopen at 8.</p>",
    ),
  });
  assert.match(html.text, /Policy/);
  assert.match(html.text, /Doors close at 6 & reopen at 8/);
  assert.doesNotMatch(html.text, /steal/);
  const email = await extractDocument({
    filename: "note.eml",
    mimeType: "message/rfc822",
    bytes: bytes(
      "From: Pat <pat@example.test>\nSubject: Picnic\nContent-Type: text/plain\n\nBring cups.",
    ),
  });
  assert.match(email.text, /Subject: Picnic/);
  assert.match(email.text, /Bring cups/);
});

test("rejects empty, oversized, invalid and unsupported uploads with actionable errors", async () => {
  await assert.rejects(
    extractDocument({ filename: "empty.txt", mimeType: "text/plain", bytes: new Uint8Array() }),
    /empty/,
  );
  await assert.rejects(
    extractDocument({
      filename: "huge.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array(50 * 1024 * 1024 + 1),
    }),
    /50 MB/,
  );
  await assert.rejects(
    extractDocument({ filename: "archive.zip", mimeType: "application/zip", bytes: bytes("zip") }),
    (error: unknown) =>
      error instanceof DocumentExtractionError && /Unsupported document type/.test(error.message),
  );
  await assert.rejects(
    extractDocument({
      filename: "bad.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([0xff, 0xfe]),
    }),
    /UTF-8/,
  );
});

test("honors cancellation before native extraction starts", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extractDocument(
      { filename: "scan.png", mimeType: "image/png", bytes: bytes("not read") },
      { signal: controller.signal },
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test(
  "stops an active native extraction when cancelled",
  { skip: process.platform !== "darwin" },
  async () => {
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("ellie-extract-")),
    );
    const controller = new AbortController();
    const pending = extractDocument(
      {
        filename: "scan.png",
        mimeType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
    const leaked = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("ellie-extract-") && !before.has(name),
    );
    assert.deepEqual(leaked, []);
  },
);

test(
  "rejects a corrupt PDF without inventing extracted text",
  { skip: process.platform !== "darwin" },
  async () => {
    await assert.rejects(
      extractDocument({
        filename: "broken.pdf",
        mimeType: "application/pdf",
        bytes: bytes("%PDF broken"),
      }),
      /corrupt|unreadable/i,
    );
  },
);

test(
  "native metadata passes through LifeStore JSON validation",
  { skip: process.platform !== "darwin" },
  async () => {
    const result = await extractDocument({
      filename: "smoke.pdf",
      mimeType: "application/pdf",
      bytes: makePdf("Stored PDF evidence"),
    });
    const directory = await mkdtemp(join(tmpdir(), "ellie-ingest-store-"));
    await chmod(directory, 0o700);
    try {
      const store = new LifeStore(join(directory, "life.sqlite"));
      const record = store.ingestSource(
        { userId: "alice" },
        {
          title: "smoke.pdf",
          scope: { type: "user", id: "alice" },
          format: "text",
          content: result.text,
          metadata: result.metadata,
        },
      );
      assert.match(record.body ?? "", /Stored PDF evidence/);
      assert.equal((record.data.metadata as Record<string, unknown>).width, undefined);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Vision reads a generated PNG", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-ocr-test-"));
  await chmod(directory, 0o700);
  try {
    const script = join(directory, "make.swift"),
      image = join(directory, "words.png");
    await writeFile(
      script,
      `import AppKit\nlet image=NSImage(size:NSSize(width:900,height:240));image.lockFocus();NSColor.white.setFill();NSRect(x:0,y:0,width:900,height:240).fill();("ELLIE GARDEN NOTES" as NSString).draw(at:NSPoint(x:45,y:90),withAttributes:[.font:NSFont.systemFont(ofSize:52),.foregroundColor:NSColor.black]);image.unlockFocus();let rep=NSBitmapImageRep(data:image.tiffRepresentation!)!;try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))`,
    );
    await promisify(execFile)("/usr/bin/xcrun", ["swift", script, image], { timeout: 30_000 });
    const result = await extractDocument({
      filename: "words.png",
      mimeType: "image/png",
      bytes: await readFile(image),
    });
    assert.match(result.text.toUpperCase(), /ELLIE/);
    assert.equal(result.metadata?.method, "ocr");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makePdf(message: string): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${message.length + 37} >>\nstream\nBT /F1 18 Tf 40 80 Td (${message}) Tj ET\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n",
    offset = pdf.length;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(offset);
    pdf += object;
    offset += object.length;
  }
  const xref = offset;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((value) => String(value).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(pdf);
}

test(
  "macOS PDFKit extracts page text and page references",
  { skip: process.platform !== "darwin" },
  async () => {
    // Minimal one-page PDF with a built-in font and a literal text drawing operation.
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      "5 0 obj\n<< /Length 50 >>\nstream\nBT /F1 18 Tf 40 80 Td (Ellie PDF smoke) Tj ET\nendstream\nendobj\n",
    ];
    let pdf = "%PDF-1.4\n",
      offset = pdf.length;
    const offsets = [0];
    for (const object of objects) {
      offsets.push(offset);
      pdf += object;
      offset += object.length;
    }
    const xref = offset;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((value) => String(value).padStart(10, "0") + " 00000 n \n")
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const result = await extractDocument({
      filename: "smoke.pdf",
      mimeType: "application/pdf",
      bytes: bytes(pdf),
    });
    assert.match(result.text, /\[Page 1\]/);
    assert.match(result.text, /Ellie PDF smoke/);
    assert.ok(result.metadata);
    assert.deepEqual(
      (result.metadata.pages as Array<{ reference: string }>)[0]?.reference,
      "page 1",
    );
  },
);
