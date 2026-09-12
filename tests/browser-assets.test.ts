import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrowserAssets } from "../apps/server/src/browser-assets.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ellie-browser-assets-"));
  for (const name of [".vite", "pair", "assets"]) await mkdir(join(dir, name));
  const manifest = {
    "pair/index.html": {
      isEntry: true,
      file: "assets/pairing-123.js",
      css: ["assets/pairing-123.css"],
      imports: ["shared"],
    },
    shared: { file: "assets/shared-123.js", assets: ["assets/icon-123.png"] },
    "index.html": { isEntry: true, file: "assets/demo-123.js" },
  };
  await writeFile(join(dir, ".vite/manifest.json"), JSON.stringify(manifest));
  for (const [path, content] of Object.entries({
    "pair/index.html": "<html>Pairing</html>",
    "index.html": "<html>Synthetic demo</html>",
    "assets/pairing-123.js": "pairing",
    "assets/pairing-123.css": "body{}",
    "assets/shared-123.js": "shared",
    "assets/icon-123.png": "image",
    "assets/demo-123.js": "demo",
  }))
    await writeFile(join(dir, path), content);
  return { dir, manifest };
}

test("pairing assets include manifest dependencies and exclude demo and private paths", async () => {
  const f = await fixture();
  try {
    const assets = await loadBrowserAssets(f.dir);
    assert.deepEqual([...assets.keys()].sort(), [
      "/",
      "/assets/icon-123.png",
      "/assets/pairing-123.css",
      "/assets/pairing-123.js",
      "/assets/shared-123.js",
    ]);
    assert.equal(assets.get("/")?.body.toString(), "<html>Pairing</html>");
    assert.equal(
      assets.get("/assets/pairing-123.js")?.contentType,
      "text/javascript; charset=utf-8",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("asset loader fails closed on traversal, missing dependencies, malformed or oversized files", async () => {
  for (const kind of [
    "traversal",
    "missing",
    "malformed",
    "oversized",
    "symlink",
    "writable-file",
    "writable-directory",
    "unknown-type",
  ] as const) {
    const f = await fixture();
    try {
      if (kind === "traversal") {
        f.manifest["pair/index.html"].file = "../private.json";
        await writeFile(join(f.dir, ".vite/manifest.json"), JSON.stringify(f.manifest));
      } else if (kind === "missing") {
        await rm(join(f.dir, "assets/shared-123.js"));
      } else if (kind === "malformed") {
        await writeFile(join(f.dir, ".vite/manifest.json"), Buffer.from([0xff, 0xfe]));
      } else if (kind === "oversized") {
        await writeFile(join(f.dir, "assets/pairing-123.js"), Buffer.alloc(2 * 1024 * 1024 + 1));
      } else if (kind === "symlink") {
        await rm(join(f.dir, "pair/index.html"));
        await symlink(join(f.dir, "index.html"), join(f.dir, "pair/index.html"));
      } else if (kind === "writable-file") {
        await chmod(join(f.dir, "assets/pairing-123.js"), 0o666);
      } else if (kind === "writable-directory") {
        await chmod(join(f.dir, "assets"), 0o777);
      } else {
        f.manifest["pair/index.html"].file = "assets/private-123.json";
        await writeFile(join(f.dir, ".vite/manifest.json"), JSON.stringify(f.manifest));
        await writeFile(join(f.dir, "assets/private-123.json"), "{}");
      }
      await assert.rejects(loadBrowserAssets(f.dir), {
        message: "Pairing page is unavailable. Run bun run demo:build and restart the coordinator.",
      });
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
