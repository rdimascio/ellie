import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../apps/browser-media-extension/", import.meta.url);
test("shipping media extension has narrow permissions and production origins", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "nativeMessaging"]);
  assert.equal(manifest.host_permissions, undefined);
  for (const file of ["background.js", "media-controller.js"]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /https:\/\/www\.netflix\.com/);
    assert.match(source, /https:\/\/www\.youtube\.com/);
    assert.doesNotMatch(source, /localhost|127\.0\.0\.1|youtube\.tv|disneyplus/);
  }
});
