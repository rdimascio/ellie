import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const source = new URL("../apps/browser-media-extension/", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ellie-media-test-"));
  const extension = join(root, "extension");
  await cp(source, extension, { recursive: true });
  for (const name of ["background.js", "media-controller.js"]) {
    const path = join(extension, name);
    const value = await readFile(path, "utf8");
    const needle = '"https://www.netflix.com", "https://www.youtube.com"';
    assert.equal(value.split(needle).length - 1, 1);
    await writeFile(path, value.replace(needle, '"http://127.0.0.1:PORT"'));
  }
  const backgroundPath = join(extension, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  const reviewedNeedle = "const reviewedWebMCPBindings = Object.freeze({});";
  assert.equal(background.split(reviewedNeedle).length - 1, 1);
  const tabGetNeedle = `async function executeWebMCP(request, controller) {
  const binding = liveBinding();
  const before = await chrome.tabs.get(binding.tabId);`;
  assert.equal(background.split(tabGetNeedle).length - 1, 1);
  await writeFile(
    backgroundPath,
    background
      .replace(
        reviewedNeedle,
        `const reviewedWebMCPBindings = Object.freeze({"http://127.0.0.1:PORT":[{name:"ellie_fixture_action",inputSchema:{type:"object",additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false}}]});`,
      )
      .replace(
        tabGetNeedle,
        `${tabGetNeedle.split("\n  const before")[0]}
  if (globalThis.__ellieTestBeforeTabGet) await globalThis.__ellieTestBeforeTabGet;
  const before = await chrome.tabs.get(binding.tabId);`,
      ) + "\nglobalThis.__ellieTestWebMCP = { bind: bindWebMCP, request: handleNativeRequest };\n",
  );
  const controllerPath = join(extension, "media-controller.js");
  const controller = await readFile(controllerPath, "utf8");
  const youtubeNeedle = 'new Set(["https://www.youtube.com"])';
  assert.equal(controller.split(youtubeNeedle).length - 1, 1);
  await writeFile(
    controllerPath,
    controller.replace(youtubeNeedle, 'new Set(["http://127.0.0.1:PORT"])'),
  );
  const manifestPath = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, extension };
}

const html = `<!doctype html><style>
body{margin:0}.spacer{height:760px}.row{display:flex;gap:12px;width:360px;overflow-x:auto}.card{flex:0 0 260px;height:120px;background:#ddd}.player{display:none}video{width:320px;height:180px}
</style><div id="catalog"><div class="spacer"></div><div class="row">
<a class="card" href="/watch?v=one" aria-label="First title">First</a><a class="card" href="/watch?v=two" aria-label="Second title">Second</a>
</div><div class="spacer"></div></div><div class="player"><video muted></video></div><script>
async function showPlayer(){
 document.querySelector('#catalog').style.display='none'; document.querySelector('.player').style.display='block';
 const canvas=document.createElement('canvas'); canvas.width=32; canvas.height=32;
 const ctx=canvas.getContext('2d'); let n=0; const timer=setInterval(()=>{ctx.fillStyle=n++%2?'red':'blue';ctx.fillRect(0,0,32,32)},40);
 const recorder=new MediaRecorder(canvas.captureStream(25)); const chunks=[]; recorder.ondataavailable=e=>chunks.push(e.data); recorder.start();
 await new Promise(r=>setTimeout(r,1200)); recorder.stop(); await new Promise(r=>recorder.onstop=r); clearInterval(timer);
 document.querySelector('video').src=URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType}));
}
addEventListener('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();history.pushState({},'',a.href);showPlayer()}});
</script>`;

async function launch(extension: string, root: string) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_server_failed");
  for (const name of ["background.js", "media-controller.js"]) {
    const path = join(extension, name);
    const value = await readFile(path, "utf8");
    await writeFile(
      path,
      value.replaceAll("http://127.0.0.1:PORT", `http://127.0.0.1:${address.port}`),
    );
  }
  const context = await chromium.launchPersistentContext(join(root, "profile"), {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${extensionId}/popup.html`);
  return { context, worker, harness, page, server };
}

async function command(harness: Page, tabId: number, value: Record<string, unknown>) {
  return harness.evaluate(
    async ({ tabId, value }) =>
      globalThis["chrome"].runtime.sendMessage({
        protocol: "ellie.media.v1",
        tabId,
        command: { actionId: crypto.randomUUID(), ...value },
      }),
    { tabId, value },
  );
}

test(
  "loaded extension performs explicit catalogue and verified video controls",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      assert.equal(
        (await command(launched.harness, tab.id, { type: "scrollViewport", direction: "down" }))
          .value.outcome,
        "scrolled",
      );
      const inspected = await command(launched.harness, tab.id, { type: "inspect" });
      assert.equal(inspected.value.candidates.length, 2);
      const first = inspected.value.candidates[0];
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "scrollRow",
            direction: "right",
            snapshotId: inspected.value.snapshotId,
            candidateId: first.id,
          })
        ).value.outcome,
        "scrolled",
      );
      const afterRow = await command(launched.harness, tab.id, { type: "inspect" });
      const second = afterRow.value.candidates.find(
        (candidate: any) => candidate.title === "Second title",
      );
      assert.ok(second);
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "open",
            snapshotId: afterRow.value.snapshotId,
            candidateId: second.id,
          })
        ).value.outcome,
        "navigation_observed",
      );
      await launched.page
        .locator("video")
        .evaluate(
          (video: any) =>
            new Promise<void>((resolve) =>
              video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
            ),
        );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "play" })).value.outcome,
        "playing",
      );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause" })).value.outcome,
        "paused",
      );
    } finally {
      await context?.close();
      if (server) {
        const ownedServer = server;
        await new Promise<void>((resolve) => ownedServer.close(() => resolve()));
      }
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "connected WebMCP tab aborts a stale history action and blocks rebinding",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await launched.page.evaluate(() => {
        const tool = {
          name: "ellie_fixture_action",
          description: "Synthetic action",
          inputSchema: { type: "object", additionalProperties: false },
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        };
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          value: {
            getTools: async () => [tool],
            executeTool: async () => {
              (globalThis as any).__ellieHistoryMutation = true;
              return { applied: true };
            },
          },
        });
      });
      const binding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      const listed = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: "list-1",
          type: "tools.list",
        }),
      );
      await launched.worker.evaluate(() => {
        globalThis.__ellieTestBeforeTabGet = new Promise<void>((resolve) => {
          globalThis.__ellieReleaseTabGet = resolve;
        });
      });
      const pending = launched.worker.evaluate(
        async ({ binding, listed }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: "execute-history",
              type: "tool.execute",
              bindingId: binding.bindingId,
              documentId: listed.documentId,
              toolHandle: listed.tools[0].handle,
              args: {},
            });
            return "completed";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        { binding, listed },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        await launched.worker.evaluate(async (tabId) => {
          try {
            await globalThis.__ellieTestWebMCP.bind(tabId);
            return "rebound";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        }, tab.id),
        "busy",
      );
      await launched.page.evaluate(() => history.pushState({}, "", "/fresh-view"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await launched.worker.evaluate(() => globalThis.__ellieReleaseTabGet());
      assert.equal(await pending, "cancelled");
      assert.equal(
        await launched.page.evaluate(() => Boolean((globalThis as any).__ellieHistoryMutation)),
        false,
      );
      const refreshed = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: "status-fresh",
          type: "binding.status",
        }),
      );
      assert.notEqual(refreshed.bindingId, binding.bindingId);
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "rejects unsupported origins, stale candidates, and ambiguous videos",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await command(launched.harness, tab.id, { type: "scrollViewport", direction: "down" });

      const beforeExpired = await launched.page.evaluate(() => scrollY);
      const expired = await launched.harness.evaluate(
        async ({ tabId, expectedUrl }) => {
          await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            files: ["media-controller.js"],
          });
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            func: async (url) => {
              try {
                await globalThis.__ellieMediaController.dispatch(
                  { type: "scrollViewport", direction: "down", actionId: crypto.randomUUID() },
                  url,
                  Date.now() - 1,
                );
                return "mutated";
              } catch (error) {
                return error instanceof Error ? error.message : "failed";
              }
            },
            args: [expectedUrl],
          });
          return result.result;
        },
        { tabId: tab.id, expectedUrl: launched.page.url() },
      );
      assert.equal(expired, "command_timeout");
      assert.equal(await launched.page.evaluate(() => scrollY), beforeExpired);

      await launched.page.evaluate(() => {
        const download = document.createElement("a");
        download.href = "/watch?v=download";
        download.download = "media";
        download.textContent = "Download title";
        download.style.cssText =
          "position:fixed;left:500px;top:20px;width:120px;height:40px;z-index:20";
        const blank = document.createElement("a");
        blank.href = "/watch?v=blank";
        blank.target = "_blank";
        blank.textContent = "New tab title";
        blank.style.cssText =
          "position:fixed;left:500px;top:80px;width:120px;height:40px;z-index:20";
        document.querySelector(".row")?.append(download, blank);
      });
      const inspected = await command(launched.harness, tab.id, { type: "inspect" });
      assert.equal(
        inspected.value.candidates.some((candidate: any) =>
          ["Download title", "New tab title"].includes(candidate.title),
        ),
        false,
      );
      const pageCount = context.pages().length;
      await launched.page
        .locator("a")
        .first()
        .evaluate((element: any) => {
          element.target = "_blank";
        });
      const stale = await command(launched.harness, tab.id, {
        type: "open",
        snapshotId: inspected.value.snapshotId,
        candidateId: inspected.value.candidates[0].id,
      });
      assert.equal(stale.ok, false);
      assert.match(stale.error, /stale_candidate|command_failed/);
      assert.equal(context.pages().length, pageCount);

      await launched.page.reload();
      const afterReload = await command(launched.harness, tab.id, {
        type: "open",
        snapshotId: inspected.value.snapshotId,
        candidateId: inspected.value.candidates[0].id,
      });
      assert.equal(afterReload.ok, false);
      await launched.page.setContent(
        "<video style='width:100px;height:100px'></video><video style='width:100px;height:100px'></video>",
      );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause" })).error,
        "ambiguous_video",
      );

      const reloadDedup = crypto.randomUUID();
      await launched.page.setContent("<video muted style='width:100px;height:100px'></video>");
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: reloadDedup })).ok,
        true,
      );
      await launched.page.reload();
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: reloadDedup })).error,
        "duplicate_action",
      );

      await launched.page.setContent("<video muted style='width:100px;height:100px'></video>");
      await launched.page.locator("video").evaluate((video: any) => {
        video.play = () => new Promise(() => {});
      });
      const preCancelled = crypto.randomUUID();
      await command(launched.harness, tab.id, {
        type: "cancel",
        targetActionId: preCancelled,
      });
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "play",
            actionId: preCancelled,
          })
        ).error,
        "cancelled",
      );
      const blocked = await command(launched.harness, tab.id, { type: "play" });
      assert.equal(blocked.error, "playback_unknown");

      const pendingId = crypto.randomUUID();
      const pendingPlay = command(launched.harness, tab.id, {
        type: "play",
        actionId: pendingId,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await command(launched.harness, tab.id, { type: "pause" })).error, "busy");
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "cancel",
            targetActionId: pendingId,
          })
        ).value.outcome,
        "cancelled",
      );
      assert.equal((await pendingPlay).error, "cancelled");

      const duplicateId = crypto.randomUUID();
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: duplicateId })).ok,
        true,
      );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: duplicateId })).error,
        "duplicate_action",
      );

      await launched.page.evaluate(() => {
        Object.defineProperty(document, "modelContext", {
          value: { getTools: () => new Promise(() => {}) },
          configurable: true,
        });
      });
      const webmcp = await command(launched.harness, tab.id, { type: "discoverWebMCP" });
      assert.equal(webmcp.value.status, "timeout");
      const current = new URL(launched.page.url());
      await launched.page.goto(`http://localhost:${current.port}/`);
      assert.equal(
        (await command(launched.harness, tab.id, { type: "inspect" })).error,
        "unsupported_page",
      );
    } finally {
      await context?.close();
      if (server) {
        const ownedServer = server;
        await new Promise<void>((resolve) => ownedServer.close(() => resolve()));
      }
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "WebMCP controller executes the exact discovered tool and aborts by signal",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await launched.page.evaluate(() => {
        const tool = {
          name: "ellie_fixture_search",
          description: "Search the synthetic fixture",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string" } },
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        };
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          value: {
            getTools: async () => {
              if ((globalThis as any).__ellieDelayTools)
                await new Promise<void>((resolve) => {
                  (globalThis as any).__ellieReleaseDelayedTools = resolve;
                });
              return [tool];
            },
            executeTool: async (candidate, args, options) => {
              if (candidate !== tool) throw new Error("wrong_tool_identity");
              (globalThis as any).__ellieWebMCPMutations =
                ((globalThis as any).__ellieWebMCPMutations || 0) + 1;
              if (args.query === "wait")
                return await new Promise((_resolve, reject) =>
                  options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  }),
                );
              return { items: [{ id: "one", label: String(args.query) }] };
            },
          },
        });
      });
      await launched.harness.evaluate(async (tabId) => {
        await globalThis["chrome"].scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          files: ["webmcp-controller.js"],
        });
      }, tab.id);
      const reviewed = [
        {
          name: "ellie_fixture_search",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string" } },
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        },
      ];
      const tools = await launched.harness.evaluate(
        async ({ tabId, reviewed }) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (policy) => globalThis.__ellieWebMCPControllerV1.list(policy),
            args: [reviewed],
          });
          return result.result;
        },
        { tabId: tab.id, reviewed },
      );
      assert.equal(tools.length, 1);
      const { handle, ...metadata } = tools[0];
      const completed = await launched.harness.evaluate(
        async ({ tabId, handle, metadata }) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (handle, metadata) =>
              globalThis.__ellieWebMCPControllerV1.execute(
                handle,
                metadata,
                { query: "cats" },
                "execution-1",
              ),
            args: [handle, metadata],
          });
          return result.result;
        },
        { tabId: tab.id, handle, metadata },
      );
      assert.deepEqual(completed, {
        navigation: false,
        value: { items: [{ id: "one", label: "cats" }] },
      });

      assert.equal(
        await launched.harness.evaluate(async (tabId) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => globalThis.__ellieWebMCPControllerV1.cancel("execution-before-register"),
          });
          return result.result;
        }, tab.id),
        true,
      );
      assert.equal(
        await launched.harness.evaluate(
          async ({ tabId, handle, metadata }) => {
            const [result] = await globalThis["chrome"].scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: async (handle, metadata) => {
                try {
                  await globalThis.__ellieWebMCPControllerV1.execute(
                    handle,
                    metadata,
                    { query: "late" },
                    "execution-before-register",
                  );
                  return "mutated";
                } catch {
                  return "cancelled";
                }
              },
              args: [handle, metadata],
            });
            return result.result;
          },
          { tabId: tab.id, handle, metadata },
        ),
        "cancelled",
      );

      await launched.page.evaluate(() => {
        (globalThis as any).__ellieDelayTools = true;
      });

      const waiting = launched.harness.evaluate(
        async ({ tabId, handle, metadata }) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: async (handle, metadata) => {
              try {
                await globalThis.__ellieWebMCPControllerV1.execute(
                  handle,
                  metadata,
                  { query: "wait" },
                  "execution-2",
                );
                return "completed";
              } catch {
                return "aborted";
              }
            },
            args: [handle, metadata],
          });
          return result.result;
        },
        { tabId: tab.id, handle, metadata },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        await launched.harness.evaluate(async (tabId) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => globalThis.__ellieWebMCPControllerV1.cancel("execution-2"),
          });
          return result.result;
        }, tab.id),
        true,
      );
      await launched.page.evaluate(() => (globalThis as any).__ellieReleaseDelayedTools());
      assert.equal(await waiting, "aborted");
      assert.equal(
        await launched.page.evaluate(() => (globalThis as any).__ellieWebMCPMutations),
        1,
      );
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);
