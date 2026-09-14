import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/App.tsx", import.meta.url);
const stylePath = new URL("../src/style.css", import.meta.url);

test("conversation controls stay secondary and the orb exposes truthful states", async () => {
  const [app, style] = await Promise.all([readFile(appPath, "utf8"), readFile(stylePath, "utf8")]);

  assert.match(app, /className="conversation-options"/);
  assert.match(app, /<summary>Options<\/summary>/);
  assert.match(app, /data-state=\{orbState\}/);
  assert.match(app, /Ellie is working/);
  assert.match(app, /Ellie needs your attention/);
  assert.doesNotMatch(app, /className=.*chat-widget/);
  assert.match(style, /\.ellie-orb\[data-state="working"\]/);
  assert.match(style, /\.ellie-orb\[data-state="attention"\]/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/);
});

test("dashboard plan copy distinguishes loading, stale refresh, failure, and empty", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /Loading plans…/);
  assert.match(app, /Updating…/);
  assert.match(app, /Plans are temporarily unavailable\./);
  assert.match(app, /No checklists yet/);
  assert.match(app, /if \(!request\.signal\.aborted\)/);
});

test("provisional chat snapshots replace in local state and stay visibly non-final", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /window\.setTimeout\(resolve, 350\)/);
  assert.match(app, /setChatProgress\(snapshot\.progress\)/);
  assert.match(app, /Drafting…/);
  assert.match(app, /Checking draft…/);
  assert.match(app, /progressController\.abort\(\)/);
  assert.match(app, /isNewerChatProgress\(chatProgressRevision\.current/);
});
