import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ImprovementQueue } from "../packages/improvement-queue/src/queue.ts";
import { qualityReceiptWork } from "../packages/improvement-queue/src/quality-receipt.ts";
import { runClaimedWork } from "../packages/improvement-queue/src/runner.ts";
import type {
  ImprovementResult,
  ImprovementWorker,
  WorkAssignment,
} from "../packages/improvement-queue/src/types.ts";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "scripts/improvement-queue.ts");

async function privateTemp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function localEvidence(
  directory: string,
  name: string,
  content = "bounded local evidence",
): Promise<{ reference: string; sha256: string }> {
  const reference = join(directory, name);
  const bytes = Buffer.from(content);
  await writeFile(reference, bytes, { mode: 0o600 });
  return { reference, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function receipt(
  directory: string,
  options: { status?: "pass" | "fail" | "error"; version?: number; commit?: string } = {},
): Promise<string> {
  const path = join(directory, `report-${options.commit?.slice(0, 4) ?? "base"}.json`);
  await writeFile(
    path,
    `${JSON.stringify({
      version: options.version ?? 1,
      createdAt: "2026-09-15T00:00:00.000Z",
      evidenceSource: { ui: "real-built", model: "synthetic" },
      source: {
        commit: options.commit ?? "a".repeat(40),
        runnerSha256: "1".repeat(64),
        fixtureSha256: "2".repeat(64),
        builtUiSha256: "3".repeat(64),
      },
      scenarios: [
        {
          name: "memory",
          status: options.status ?? "fail",
          checks: ["PRIVATE RAW FAILURE MUST NOT ENTER QUEUE"],
        },
      ],
      commands: ["never execute this receipt text"],
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

async function runCli(args: string[]): Promise<unknown> {
  const result = await execute(process.execPath, [cli, ...args], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

test("duplicate quality receipt ingestion creates one redacted work item", async () => {
  const directory = await privateTemp("ellie-improvement-dedup-");
  try {
    const report = await receipt(directory);
    const queue = new ImprovementQueue(join(directory, "state"));
    const input = qualityReceiptWork(report);
    assert.throws(
      () => queue.enqueue({ ...input, deduplicationKey: "0".repeat(64) }),
      /does not match its evidence inputs/,
    );
    const first = queue.enqueue(input);
    const second = queue.enqueue(qualityReceiptWork(report));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.item.id, first.item.id);
    assert.equal(queue.list().length, 1);
    assert.equal(first.item.evidence.reference, report);
    assert.match(first.item.evidence.sha256, /^[a-f0-9]{64}$/);
    queue.close();
    const database = await readFile(join(directory, "state", "queue.sqlite"));
    assert.equal(database.includes(Buffer.from("PRIVATE RAW FAILURE MUST NOT ENTER QUEUE")), false);
    assert.equal(database.includes(Buffer.from("never execute this receipt text")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate processes serialize concurrent claims", async () => {
  const directory = await privateTemp("ellie-improvement-claims-");
  try {
    const state = join(directory, "state");
    const report = await receipt(directory);
    await runCli(["enqueue", "--state-dir", state, "--receipt", report]);
    const claims = await Promise.all([
      runCli(["claim", "--state-dir", state, "--owner", "worker-one", "--lease-ms", "60000"]),
      runCli(["claim", "--state-dir", state, "--owner", "worker-two", "--lease-ms", "60000"]),
    ]);
    const won = claims.filter((value) => value !== null) as Array<{
      ownerId: string;
      item: { state: string; attemptsUsed: number };
    }>;
    assert.equal(won.length, 1);
    assert.match(won[0]!.ownerId, /^worker-(one|two)$/);
    assert.equal(won[0]!.item.state, "leased");
    assert.equal(won[0]!.item.attemptsUsed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate process restart retains the same item and live ownership", async () => {
  const directory = await privateTemp("ellie-improvement-restart-");
  try {
    const state = join(directory, "state");
    const report = await receipt(directory);
    const enqueued = (await runCli(["enqueue", "--state-dir", state, "--receipt", report])) as {
      item: { id: string };
    };
    const claim = (await runCli([
      "claim",
      "--state-dir",
      state,
      "--owner",
      "restart-worker",
      "--lease-ms",
      "60000",
    ])) as { item: { id: string }; leaseId: string; ownerId: string };
    const reopened = (await runCli([
      "status",
      "--state-dir",
      state,
      "--item",
      enqueued.item.id,
    ])) as { id: string; state: string; leaseId: string; ownerId: string };
    assert.equal(claim.item.id, enqueued.item.id);
    assert.equal(reopened.id, enqueued.item.id);
    assert.equal(reopened.state, "leased");
    assert.equal(reopened.ownerId, claim.ownerId);
    assert.equal(reopened.leaseId, claim.leaseId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired ownership cannot redispatch and local operator may only mark it blocked", async () => {
  const directory = await privateTemp("ellie-improvement-reconcile-");
  let now = 100;
  try {
    const report = await receipt(directory);
    const input = qualityReceiptWork(report, { attemptBudget: 2, maxRuntimeMs: 1000 });
    let queue = new ImprovementQueue(join(directory, "state"), { now: () => now });
    const item = queue.enqueue(input).item;
    const claim = queue.claim("uncertain-worker", 1000)!;
    queue.close();

    now = 1101;
    queue = new ImprovementQueue(join(directory, "state"), { now: () => now });
    assert.equal(queue.get(item.id)?.state, "reconciliation_required");
    assert.equal(queue.get(item.id)?.ownerId, "uncertain-worker");
    assert.equal(queue.get(item.id)?.leaseId, claim.leaseId);
    assert.equal(queue.claim("second-worker", 1000), undefined);
    let staleDispatches = 0;
    await assert.rejects(
      runClaimedWork(queue, claim, {
        ownerId: "uncertain-worker",
        async run(assignment) {
          staleDispatches += 1;
          return {
            resultKey: "must-not-run",
            outcome: "no_change",
            originEvidenceSha256: assignment.originEvidenceSha256,
            evidenceReference: "/private/stale.json",
            evidenceSha256: "0".repeat(64),
          };
        },
      }),
      /current unexpired owner lease/,
    );
    assert.equal(staleDispatches, 0);
    const reconciliationEvidence = await localEvidence(directory, "reconciliation.json");
    assert.throws(
      () =>
        queue.markBlocked(
          item.id,
          claim.leaseId,
          { role: "worker" as never, id: "uncertain-worker" },
          {
            evidenceReference: reconciliationEvidence.reference,
            evidenceSha256: reconciliationEvidence.sha256,
          },
        ),
      /local-operator attribution/,
    );
    assert.throws(
      () =>
        queue.markBlocked(
          item.id,
          claim.leaseId,
          { role: "local-operator", id: "operator-1" },
          {
            evidenceReference: reconciliationEvidence.reference,
            evidenceSha256: "0".repeat(64),
          },
        ),
      /does not match its private file/,
    );
    const reconciliation = queue.markBlocked(
      item.id,
      claim.leaseId,
      { role: "local-operator", id: "operator-1" },
      {
        evidenceReference: reconciliationEvidence.reference,
        evidenceSha256: reconciliationEvidence.sha256,
      },
    );
    assert.equal(reconciliation.decision, "blocked");
    await rm(reconciliationEvidence.reference);
    assert.deepEqual(
      queue.markBlocked(
        item.id,
        claim.leaseId,
        { role: "local-operator", id: "operator-1" },
        {
          evidenceReference: reconciliationEvidence.reference,
          evidenceSha256: reconciliationEvidence.sha256,
        },
      ),
      reconciliation,
    );
    assert.throws(
      () =>
        queue.markBlocked(
          item.id,
          claim.leaseId,
          { role: "local-operator", id: "operator-1" },
          {
            evidenceReference: reconciliationEvidence.reference,
            evidenceSha256: "f".repeat(64),
          },
        ),
      /different reconciliation record/,
    );
    assert.equal(queue.get(item.id)?.state, "blocked");
    assert.equal(queue.claim("second-worker", 1000), undefined);
    queue.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("result recording is evidence-bound and idempotent, including after uncertain recovery", async () => {
  const directory = await privateTemp("ellie-improvement-result-");
  let now = 100;
  try {
    const report = await receipt(directory);
    let queue = new ImprovementQueue(join(directory, "state"), { now: () => now });
    const item = queue.enqueue(qualityReceiptWork(report, { maxRuntimeMs: 1000 })).item;
    const claim = queue.claim("candidate-worker", 1000)!;
    queue.close();
    now = 1101;
    queue = new ImprovementQueue(join(directory, "state"), { now: () => now });
    const outcomeEvidence = await localEvidence(directory, "candidate-evidence.json");
    const result: ImprovementResult = {
      resultKey: "candidate-result-1",
      outcome: "candidate",
      originEvidenceSha256: item.evidence.sha256,
      evidenceReference: outcomeEvidence.reference,
      evidenceSha256: outcomeEvidence.sha256,
      candidateCommit: "b".repeat(40),
      candidateReference: "https://github.com/example/ellie/pull/1",
    };
    assert.throws(
      () =>
        queue.recordResult(item.id, claim.ownerId, claim.leaseId, {
          ...result,
          originEvidenceSha256: "0".repeat(64),
        }),
      /originating evidence/,
    );
    assert.throws(
      () =>
        queue.recordResult(item.id, claim.ownerId, claim.leaseId, {
          ...result,
          evidenceSha256: "0".repeat(64),
        }),
      /does not match its private file/,
    );
    const recorded = queue.recordResult(item.id, claim.ownerId, claim.leaseId, result);
    await rm(outcomeEvidence.reference);
    const repeated = queue.recordResult(item.id, claim.ownerId, claim.leaseId, result);
    assert.equal(recorded.state, "candidate_recorded");
    assert.equal(recorded.promotionState, "awaiting_release_owner");
    assert.deepEqual(repeated, recorded);
    assert.throws(
      () =>
        queue.recordResult(item.id, claim.ownerId, claim.leaseId, {
          ...result,
          originEvidenceSha256: "0".repeat(64),
        }),
      /originating evidence/,
    );
    const differentEvidence = await localEvidence(directory, "different-candidate-evidence.json");
    assert.throws(
      () =>
        queue.recordResult(item.id, claim.ownerId, claim.leaseId, {
          ...result,
          evidenceReference: differentEvidence.reference,
          evidenceSha256: differentEvidence.sha256,
        }),
      /different recorded result/,
    );
    queue.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deterministic worker receives only the narrow assignment and records a structured result", async () => {
  const directory = await privateTemp("ellie-improvement-worker-");
  try {
    const report = await receipt(directory, { commit: "c".repeat(40) });
    const queue = new ImprovementQueue(join(directory, "state"));
    queue.enqueue(qualityReceiptWork(report));
    const claim = queue.claim("deterministic-worker", 60000)!;
    const outcomeEvidence = await localEvidence(directory, "deterministic-evidence.json");
    let received: WorkAssignment | undefined;
    const worker: ImprovementWorker = {
      ownerId: "deterministic-worker",
      async run(assignment, signal) {
        assert.equal(signal.aborted, false);
        received = assignment;
        assert.equal("commands" in assignment, false);
        assert.equal("checks" in assignment, false);
        return {
          resultKey: "deterministic-result-1",
          outcome: "no_change",
          originEvidenceSha256: assignment.originEvidenceSha256,
          evidenceReference: outcomeEvidence.reference,
          evidenceSha256: outcomeEvidence.sha256,
        };
      },
    };
    const result = await runClaimedWork(queue, claim, worker);
    assert.equal(received?.scenario, "memory");
    assert.equal(result.state, "succeeded");
    assert.equal(result.outcome, "no_change");
    queue.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker deadline returns while noncooperative work remains quarantined", async () => {
  const directory = await privateTemp("ellie-improvement-never-settles-");
  try {
    const report = await receipt(directory, { commit: "d".repeat(40) });
    const queue = new ImprovementQueue(join(directory, "state"));
    queue.enqueue(qualityReceiptWork(report, { maxRuntimeMs: 1000 }));
    const claim = queue.claim("noncooperative-worker", 1000)!;
    const started = performance.now();
    await assert.rejects(
      runClaimedWork(queue, claim, {
        ownerId: "noncooperative-worker",
        async run() {
          return new Promise<ImprovementResult>(() => {});
        },
      }),
      /deadline expired.*remains uncertain/,
    );
    assert.ok(performance.now() - started < 2500);
    const uncertain = queue.get(claim.item.id)!;
    assert.equal(uncertain.state, "reconciliation_required");
    assert.equal(uncertain.ownerId, claim.ownerId);
    assert.equal(uncertain.leaseId, claim.leaseId);
    assert.equal(queue.claim("replacement-worker", 1000), undefined);
    queue.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late worker completion cannot record a result or release uncertain ownership", async () => {
  const directory = await privateTemp("ellie-improvement-late-result-");
  try {
    const report = await receipt(directory, { commit: "e".repeat(40) });
    const outcomeEvidence = await localEvidence(directory, "late-evidence.json");
    const queue = new ImprovementQueue(join(directory, "state"));
    queue.enqueue(qualityReceiptWork(report, { maxRuntimeMs: 1000 }));
    const claim = queue.claim("late-worker", 1000)!;
    await assert.rejects(
      runClaimedWork(queue, claim, {
        ownerId: "late-worker",
        async run(assignment) {
          await delay(1150);
          return {
            resultKey: "late-result",
            outcome: "no_change",
            originEvidenceSha256: assignment.originEvidenceSha256,
            evidenceReference: outcomeEvidence.reference,
            evidenceSha256: outcomeEvidence.sha256,
          };
        },
      }),
      /deadline expired.*remains uncertain/,
    );
    await delay(250);
    const uncertain = queue.get(claim.item.id)!;
    assert.equal(uncertain.state, "reconciliation_required");
    assert.equal(uncertain.resultKey, undefined);
    assert.equal(uncertain.outcome, undefined);
    assert.equal(queue.claim("replacement-worker", 1000), undefined);
    queue.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state path rejects outside aliases into a checkout and unsafe SQLite sidecars", async () => {
  const directory = await privateTemp("ellie-improvement-paths-");
  try {
    const alias = join(directory, "outside-alias");
    await symlink(root, alias, "dir");
    await assert.rejects(
      execute(process.execPath, [cli, "status", "--state-dir", join(alias, "private-state")]),
      (error: unknown) =>
        /canonical path without symlink ancestors/.test(
          String((error as { stderr?: string }).stderr ?? error),
        ),
    );

    const state = join(directory, "state");
    const queue = new ImprovementQueue(state);
    queue.close();
    const sidecarTarget = await localEvidence(directory, "sidecar-target");
    await symlink(sidecarTarget.reference, join(state, "queue.sqlite-wal"));
    assert.throws(() => new ImprovementQueue(state), /could not be opened safely/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("open queue rejects replacement of its directory and database path identity", async () => {
  const directory = await privateTemp("ellie-improvement-identity-");
  try {
    const state = join(directory, "state");
    const moved = join(directory, "moved-state");
    const queue = new ImprovementQueue(state);
    await rename(state, moved);
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(state, "queue.sqlite"), "replacement", { mode: 0o600 });
    assert.throws(() => queue.list(), /storage identity changed/);
    assert.throws(() => queue.close(), /storage identity changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quality adapter rejects malformed, unsupported and passing receipts", async () => {
  const directory = await privateTemp("ellie-improvement-receipt-");
  try {
    const unsupported = await receipt(directory, { version: 2, commit: "d".repeat(40) });
    assert.throws(() => qualityReceiptWork(unsupported), /Unsupported quality receipt format/);
    const passing = await receipt(directory, { status: "pass", commit: "e".repeat(40) });
    assert.throws(() => qualityReceiptWork(passing), /mechanical pass is not semantic acceptance/);
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{", { mode: 0o600 });
    assert.throws(() => qualityReceiptWork(malformed), /not valid JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
