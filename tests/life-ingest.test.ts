import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractDocument, DocumentExtractionError } from "../packages/life-ingest/src/index.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

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
