import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  stageBrowserCompanion,
  verifyBrowserCompanionClosure,
} from "../scripts/build-service-payload.mjs";

const source = new URL("../apps/browser-media-extension/", import.meta.url).pathname;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("packaged browser companion contains every transitively referenced provider script", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-companion-package-"));
  const input = join(root, "source/apps/browser-media-extension");
  const release = join(root, "release/payload");
  try {
    await cp(source, input, { recursive: true });
    const output = await stageBrowserCompanion(join(root, "source"), release);
    const closure = await verifyBrowserCompanionClosure(output);
    assert.deepEqual(closure, [
      "background.js",
      "media-controller.js",
      "popup.html",
      "popup.js",
      "webmcp-controller.js",
      "youtube-tv-controller.js",
    ]);
    for (const name of closure)
      assert.equal(
        hash(await readFile(join(input, name))),
        hash(await readFile(join(output, name))),
      );

    await rm(join(output, "youtube-tv-controller.js"));
    await assert.rejects(
      verifyBrowserCompanionClosure(output),
      /Browser companion script is missing: youtube-tv-controller\.js/,
    );
    await rm(join(input, "youtube-tv-controller.js"));
    await assert.rejects(
      stageBrowserCompanion(join(root, "source"), join(root, "missing-source-payload")),
      /Browser companion script is missing: youtube-tv-controller\.js/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package closure discovers a newly referenced provider without a hardcoded module list", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-companion-dynamic-"));
  const input = join(root, "source/apps/browser-media-extension");
  try {
    await cp(source, input, { recursive: true });
    const background = join(input, "background.js");
    const original = await readFile(background, "utf8");
    await writeFile(background, `${original}\nconst fixtureProvider = "future-provider.js";\n`);
    await writeFile(join(input, "future-provider.js"), "globalThis.fixtureProvider = true;\n");
    const output = await stageBrowserCompanion(join(root, "source"), join(root, "release/payload"));
    assert.ok((await verifyBrowserCompanionClosure(output)).includes("future-provider.js"));
    await rm(join(output, "future-provider.js"));
    await assert.rejects(
      verifyBrowserCompanionClosure(output),
      /Browser companion script is missing: future-provider\.js/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
