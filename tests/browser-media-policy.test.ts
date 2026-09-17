import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../apps/browser-media-extension/", import.meta.url);
test("shipping media extension has narrow permissions and production origins", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "nativeMessaging"]);
  assert.equal(manifest.host_permissions, undefined);
  for (const file of [
    "background.js",
    "media-controller.js",
    "youtube-tv-controller.js",
    "disneyplus-controller.js",
  ]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /localhost|127\.0\.0\.1/);
    if (file === "media-controller.js") {
      assert.match(source, /https:\/\/www\.netflix\.com/);
      assert.match(source, /https:\/\/www\.youtube\.com/);
      assert.doesNotMatch(source, /tv\.youtube\.com/);
      assert.doesNotMatch(source, /disneyplus\.com/);
    } else if (file === "youtube-tv-controller.js") {
      assert.match(source, /https:\/\/tv\.youtube\.com/);
      assert.doesNotMatch(source, /disneyplus\.com/);
    } else if (file === "disneyplus-controller.js") {
      assert.match(source, /https:\/\/www\.disneyplus\.com/);
      assert.doesNotMatch(source, /tv\.youtube\.com|netflix\.com/);
    } else {
      assert.match(source, /https:\/\/tv\.youtube\.com/);
      assert.match(source, /https:\/\/www\.disneyplus\.com/);
    }
  }
});
