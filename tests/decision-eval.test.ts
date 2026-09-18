import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseRoutingCases,
  scoreRoutingCase,
  summarizeRoutingEvaluation,
} from "../packages/router/src/evaluation.ts";
import type { RoutingCase } from "../packages/router/src/evaluation.ts";

const browser = "company.thebrowser.Browser";
const messages = "com.apple.MobileSMS";
const openBrowser = { tool: "app.open", app: browser } as const;
const openMessages = { tool: "app.open", app: messages } as const;
const leftBrowser = {
  tool: "window.place",
  app: browser,
  layout: "left",
  monitor: "current",
} as const;

test("the committed benchmark is synthetic, labeled, and varied", () => {
  const path = fileURLToPath(new URL("../examples/decision-routing-cases.json", import.meta.url));
  const cases = parseRoutingCases(JSON.parse(readFileSync(path, "utf8")));
  assert.ok(cases.length >= 200 && cases.length <= 300);
  assert.ok(new Set(cases.map((row) => row.category)).size >= 15);
  const categories = new Set(cases.map((row) => row.category));
  for (const split of ["development", "heldout"] as const)
    assert.deepEqual(
      new Set(cases.filter((row) => row.split === split).map((row) => row.category)),
      categories,
    );
  assert.ok(cases.some((row) => row.context?.lastApp));
  assert.ok(
    cases.every((row) => row.expected.kind !== "plan" || row.expected.actions.length === 1),
  );
  assert.ok(
    cases
      .filter((row) => row.category === "compound")
      .every((row) => row.expected.kind === "abstain" && row.labelReason),
  );
  assert.ok(cases.some((row) => row.expected.kind === "abstain"));
});

test("whole-plan scoring catches wrong app, fields, action order, and partial plans", () => {
  const row: RoutingCase = {
    id: "exact",
    category: "compound",
    split: "development",
    input: "Open Arc then put it left.",
    expected: { kind: "plan", actions: [openBrowser, leftBrowser] },
  };
  assert.equal(
    scoreRoutingCase(row, { kind: "plan", actions: [openBrowser, leftBrowser] }).outcome,
    "correct_plan",
  );
  assert.equal(
    scoreRoutingCase(row, { kind: "plan", actions: [openMessages, leftBrowser] }).outcome,
    "wrong_plan",
  );
  assert.equal(
    scoreRoutingCase(row, { kind: "plan", actions: [leftBrowser, openBrowser] }).outcome,
    "wrong_plan",
  );
  assert.equal(
    scoreRoutingCase(row, { kind: "plan", actions: [openBrowser] }).outcome,
    "wrong_plan",
  );
  assert.equal(
    scoreRoutingCase(row, {
      kind: "plan",
      actions: [openBrowser, { ...leftBrowser, monitor: "primary" }],
    }).outcome,
    "wrong_plan",
  );
  assert.equal(scoreRoutingCase(row, { kind: "abstain" }).outcome, "missed_plan");
});

test("false executions are separate from wrong plans and conservative abstentions", () => {
  const abstain: RoutingCase = {
    id: "abs",
    category: "negation",
    split: "heldout",
    input: "Do not open Arc.",
    expected: { kind: "abstain" },
  };
  const plan: RoutingCase = {
    id: "plan",
    category: "open",
    split: "development",
    input: "Open Arc.",
    expected: { kind: "plan", actions: [openBrowser] },
  };
  const scores = [
    scoreRoutingCase(abstain, { kind: "plan", actions: [openBrowser], latencyMs: 10 }),
    scoreRoutingCase(abstain, { kind: "abstain", fallback: true, latencyMs: 20 }),
    scoreRoutingCase(plan, {
      kind: "plan",
      actions: [openMessages],
      latencyMs: 30,
      model: "jev-resolved",
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
    scoreRoutingCase(plan, { kind: "abstain", latencyMs: 40 }),
  ];
  const report = summarizeRoutingEvaluation(scores, {
    dataset: "unit@sha256:test",
    model: "unit",
    split: "all",
    pricePerMillionInputTokensUsd: 1,
    pricePerMillionOutputTokensUsd: 2,
  });
  assert.equal(report.falseExecutions, 1);
  assert.equal(report.wrongPlans, 1);
  assert.equal(report.missedPlans, 1);
  assert.equal(report.correctAbstentions, 1);
  assert.equal(report.exactPlanAccuracy, 0);
  assert.equal(report.abstainAccuracy, 0.5);
  assert.equal(report.coverage, 0.5);
  assert.equal(report.fallbackRate, 0.25);
  assert.deepEqual(report.latencyMs, { p50: 20, p95: 40 });
  assert.deepEqual(report.usage, {
    inputTokens: 100,
    outputTokens: 20,
    reportedCases: 1,
    complete: true,
  });
  assert.equal(report.estimatedCostUsd, 0.00014);
  assert.deepEqual(report.observedModels, ["jev-resolved"]);
});

test("incomplete provider usage omits an otherwise misleading cost estimate", () => {
  const row: RoutingCase = {
    id: "x",
    category: "open",
    input: "Open Arc",
    split: "heldout",
    expected: { kind: "plan", actions: [openBrowser] },
  };
  const score = scoreRoutingCase(row, {
    kind: "abstain",
    semanticAttempt: true,
    fallback: true,
    usageKnown: false,
  });
  const report = summarizeRoutingEvaluation([score], {
    dataset: "unit",
    model: "jev-test",
    thresholds: { minProbability: 0.98, minMargin: 0.2 },
    timeoutMs: 3000,
    pricePerMillionInputTokensUsd: 1,
    pricePerMillionOutputTokensUsd: 2,
  });
  assert.equal(report.usage.complete, false);
  assert.equal(report.estimatedCostUsd, undefined);
  assert.equal(report.semanticAttemptRate, 1);
  assert.deepEqual(report.thresholds, { minProbability: 0.98, minMargin: 0.2 });
  assert.equal(report.timeoutMs, 3000);
});

test("timeout range is rejected before any cloud provider request", () => {
  const script = fileURLToPath(new URL("../scripts/evaluate-routing.ts", import.meta.url));
  for (const value of ["99", "10001", "NaN", "1.5"]) {
    const run = spawnSync(
      process.execPath,
      [script, "--provider", "typesafe", "--allow-cloud", "--timeout-ms", value, "--limit", "1"],
      { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "test-key" } },
    );
    assert.equal(run.status, 1, value);
    assert.match(run.stderr, /--timeout-ms must be an integer from 100 to 10000/);
    assert.equal(run.stdout, "");
  }
});

test("Gateway evaluator requires disclosure and its own explicit process key", () => {
  const script = fileURLToPath(new URL("../scripts/evaluate-routing.ts", import.meta.url));
  const env = { ...process.env, AI_GATEWAY_API_KEY: "" };
  const noDisclosure = spawnSync(
    process.execPath,
    [script, "--provider", "gateway", "--limit", "1"],
    { encoding: "utf8", env },
  );
  assert.equal(noDisclosure.status, 1);
  assert.match(noDisclosure.stderr, /--allow-cloud/);
  const noKey = spawnSync(
    process.execPath,
    [script, "--provider", "gateway", "--allow-cloud", "--limit", "1"],
    { encoding: "utf8", env },
  );
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /AI_GATEWAY_API_KEY/);
  assert.equal(noKey.stdout, "");
  const wrongModel = spawnSync(
    process.execPath,
    [script, "--provider", "gateway", "--allow-cloud", "--model", "jev-1.13.0"],
    { encoding: "utf8", env },
  );
  assert.equal(wrongModel.status, 1);
  assert.match(wrongModel.stderr, /fixed typesafe-ai\/jev alias/);
});

test("bad labels and malformed predictions fail closed", () => {
  assert.throws(() =>
    parseRoutingCases([
      {
        id: "x",
        category: "open",
        input: "Open Arc",
        split: "development",
        expected: { kind: "plan", actions: [{ ...openBrowser, extra: "ignored" }] },
      },
    ]),
  );
  assert.throws(() =>
    parseRoutingCases([
      {
        id: "x",
        category: "open",
        input: "Open Arc",
        split: "development",
        expected: { kind: "plan", actions: [{ tool: "shell.exec" }] },
      },
    ]),
  );
  const row: RoutingCase = {
    id: "x",
    category: "open",
    input: "Open Arc",
    split: "heldout",
    expected: { kind: "plan", actions: [openBrowser] },
  };
  assert.throws(() => scoreRoutingCase(row, { kind: "plan", actions: [] }));
  assert.throws(() => scoreRoutingCase(row, { kind: "abstain", actions: [openBrowser] }));
});
