import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERATED_APP_BROWSER_ACCEPTANCE,
  GENERATED_APP_QUALITY_GUIDANCE,
  BoundedPluginBuilder,
  PluginBuildError,
  generatedAppQualityIssue,
} from "../packages/life-harness/src/build.ts";

test("generated app quality guidance covers theme, accessibility, responsiveness, and recovery", () => {
  assert.match(GENERATED_APP_QUALITY_GUIDANCE, /light\/dark color-scheme/);
  assert.match(GENERATED_APP_QUALITY_GUIDANCE, /programmatic labels/);
  assert.match(GENERATED_APP_QUALITY_GUIDANCE, /visible keyboard focus/);
  assert.match(GENERATED_APP_QUALITY_GUIDANCE, /responsive/);
  assert.match(GENERATED_APP_QUALITY_GUIDANCE, /inline error with a labeled retry control/);
  assert.match(GENERATED_APP_QUALITY_GUIDANCE, /preserve existing storage keys/);
  assert.deepEqual(GENERATED_APP_BROWSER_ACCEPTANCE.exercises, [
    "meaningful generated controls",
    "storage failure and retry",
    "persistence after reload",
    "rejected storage bounds and capabilities",
    "blocked network and parent-document access",
    "revision and rollback storage compatibility",
  ]);
  assert.match(GENERATED_APP_BROWSER_ACCEPTANCE.limitation, /requires.*browser flow/);
});

test("quality validation rejects only structurally empty visual documents", () => {
  const builder = new BoundedPluginBuilder();
  for (const html of [
    "<!doctype html><html><head><title>Empty</title></head><body></body></html>",
    "<!-- placeholder --><style>body { color: red }</style>",
    "<script>/* placeholder */</script>",
  ])
    assert.throws(
      () => builder.validateCandidate({ html }),
      (error: unknown) =>
        error instanceof PluginBuildError &&
        error.code === "invalid_candidate" &&
        !error.message.includes(html),
    );

  assert.throws(
    () => builder.validateCandidate({ html: "<html></html>" }, { revision: true }),
    /current app was kept/,
  );
  assert.match(generatedAppQualityIssue("<body></body>")!, /no visible document/);
});

test("quality validation accepts static, canvas, control, and dynamically rendered apps", () => {
  for (const html of [
    "<!doctype html><main>A useful static document</main>",
    "<!doctype html><head><script>document.addEventListener('DOMContentLoaded', () => { document.body.textContent = 'Ready'; });</script></head><body></body>",
    "<!doctype html><canvas aria-label='Game board'></canvas>",
    "<!doctype html><button aria-label='Add item'></button>",
    "<!doctype html><script>document.body.textContent = 'Rendered';</script>",
  ])
    assert.doesNotThrow(() => new BoundedPluginBuilder().validateCandidate({ html }));
});
