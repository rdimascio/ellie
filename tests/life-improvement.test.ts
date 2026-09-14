import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";
import {
  LifeImprovementEngine,
  LifeImprovementError,
  LifeLearning,
} from "../packages/life-learning/src/index.ts";
import { LifeTeaching } from "../packages/life-teaching/src/index.ts";

const actor = { userId: "alice" };
const scope = { type: "user" as const, id: "alice" };

function fixture(timeoutMs = 90_000) {
  const dir = mkdtempSync(join(tmpdir(), "ellie-improvement-"));
  const store = new LifeStore(join(dir, "life.sqlite"));
  const teaching = new LifeTeaching(store, () => 1_000);
  return {
    dir,
    store,
    teaching,
    learning: new LifeLearning(store),
    make: (model: ConstructorParameters<typeof LifeImprovementEngine>[0]["model"]) =>
      new LifeImprovementEngine({ store, teaching, model, timeoutMs, now: () => 1_000 }),
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a private correction becomes reviewed guidance only after explicit atomic adoption", async () => {
  const f = fixture();
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Answer more directly",
      rating: -1,
      example: {
        prompt: "When is dinner?",
        response: "Here is a long preamble. Dinner is at seven.",
        preferredResponse: "Dinner is at seven.",
      },
    });
    const engine = f.make({
      async suggestImprovement(request) {
        assert.equal(request.examples.length, 1);
        return {
          title: "Lead with the answer",
          instructions: "Put the direct answer before supporting detail.",
          rationale: "The selected correction preferred a direct opening.",
        };
      },
      async previewImprovement(request) {
        assert.equal(request.instructions, "Put the direct answer before supporting detail.");
        return { reply: "Dinner is at seven." };
      },
    });
    assert.equal(engine.modelAvailable, true);
    const proposed = await engine.propose(actor, {
      feedback: [{ id: feedback.id, revision: feedback.revision }],
    });
    assert.equal(proposed.status, "ready");
    assert.equal(proposed.previews[0]?.candidateResponse, "Dinner is at seven.");
    assert.deepEqual(f.teaching.resolve(actor, scope), []);

    const adopted = engine.adopt(actor, proposed.record.id, proposed.record.revision);
    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.guideId, proposed.record.id);
    assert.equal(f.teaching.resolve(actor, scope)[0]?.instructions, proposed.instructions);
    assert.throws(
      () => engine.adopt(actor, proposed.record.id, proposed.record.revision),
      /ready|changed/i,
    );
    const revised = f.teaching.revise(actor, adopted.record.id, adopted.record.revision, {
      instructions: "State the direct answer first, then add one useful detail.",
    });
    let latest = revised;
    for (let index = 0; index < 9; index += 1)
      latest = f.teaching.revise(actor, latest.record.id, latest.record.revision, {
        instructions: `Revision ${index}: state the direct answer first.`,
      });
    const audit = engine.get(actor, latest.record.id);
    assert.equal(audit.status, "adopted");
    assert.equal(audit.instructions, "Put the direct answer before supporting detail.");
  } finally {
    f.close();
  }
});

test("changed feedback makes a proposal stale, hides replay text, and blocks adoption", async () => {
  const f = fixture();
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Use the corrected answer",
      rating: -1,
      example: { prompt: "Secret prompt", response: "Old secret reply" },
    });
    const engine = f.make({
      async suggestImprovement() {
        return { title: "Correction", instructions: "Follow the correction.", rationale: "Review" };
      },
      async previewImprovement() {
        return { reply: "Candidate secret reply" };
      },
    });
    const proposal = await engine.propose(actor, {
      feedback: [{ id: feedback.id, revision: feedback.revision }],
    });
    f.store.deleteRecord(actor, feedback.id, feedback.revision);
    const stale = engine.get(actor, proposal.record.id);
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.previews, []);
    assert.throws(
      () => engine.adopt(actor, stale.record.id, stale.record.revision),
      (error) => error instanceof LifeImprovementError && error.code === "stale",
    );
  } finally {
    f.close();
  }
});

test("editing a ready candidate invalidates its previews and malformed rows do not break listing", async () => {
  const f = fixture();
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Improve this",
      rating: -1,
      example: { prompt: "Prompt", response: "Recorded reply" },
    });
    const engine = f.make({
      async suggestImprovement() {
        return { title: "Bound candidate", instructions: "Original candidate", rationale: "Why" };
      },
      async previewImprovement() {
        return { reply: "Candidate reply" };
      },
    });
    const proposal = await engine.propose(actor, {
      feedback: [{ id: feedback.id, revision: feedback.revision }],
    });
    const edited = f.store.updateRecord(actor, proposal.record.id, proposal.record.revision, {
      body: "Manually changed candidate",
    });
    f.store.createRecord(actor, {
      kind: "routine",
      scope,
      title: "Malformed proposal",
      body: "Malformed",
      data: { type: "learning-improvement-v1" },
    });
    const listed = engine.list(actor);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.record.id, edited.id);
    assert.equal(listed[0]?.status, "stale");
    assert.deepEqual(listed[0]?.previews, []);
    assert.throws(
      () => engine.adopt(actor, edited.id, edited.revision),
      (error) => error instanceof LifeImprovementError && error.code === "stale",
    );
  } finally {
    f.close();
  }
});

test("deadline and context changes prevent late proposal persistence", async () => {
  const f = fixture(5);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Shorter",
      rating: -1,
      example: { prompt: "Question", response: "Long answer" },
    });
    const engine = f.make({
      async suggestImprovement() {
        await blocked;
        return { title: "Late", instructions: "Late instructions", rationale: "Late" };
      },
      async previewImprovement() {
        return { reply: "Late" };
      },
    });
    await assert.rejects(
      engine.propose(actor, { feedback: [{ id: feedback.id, revision: feedback.revision }] }),
      (error) => error instanceof LifeImprovementError && error.code === "timeout",
    );
    assert.equal(await engine.settleActive(0), false);
    release();
    assert.equal(await engine.settleActive(), true);
    assert.deepEqual(engine.list(actor), []);
  } finally {
    release();
    f.close();
  }
});

test("a feedback revision changed during inference prevents proposal persistence", async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Shorter",
      rating: -1,
      example: { prompt: "Question", response: "Long answer" },
    });
    const engine = f.make({
      async suggestImprovement() {
        entered();
        await blocked;
        return { title: "Candidate", instructions: "Instructions", rationale: "Rationale" };
      },
      async previewImprovement() {
        return { reply: "Preview" };
      },
    });
    const pending = engine.propose(actor, {
      feedback: [{ id: feedback.id, revision: feedback.revision }],
    });
    await started;
    f.store.updateRecord(actor, feedback.id, feedback.revision, { body: "Different correction" });
    release();
    await assert.rejects(
      pending,
      (error) => error instanceof LifeImprovementError && error.code === "stale",
    );
    assert.deepEqual(engine.list(actor), []);
  } finally {
    release();
    f.close();
  }
});

test("improvement proposals are actor-private and dismissal is revision checked", async () => {
  const f = fixture();
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Improve",
      rating: -1,
      example: { prompt: "Question", response: "Answer" },
    });
    const engine = f.make({
      async suggestImprovement() {
        return { title: "Private", instructions: "Private guidance", rationale: "Private" };
      },
      async previewImprovement() {
        return { reply: "Preview" };
      },
    });
    const proposal = await engine.propose(actor, {
      feedback: [{ id: feedback.id, revision: feedback.revision }],
    });
    assert.throws(() => engine.get({ userId: "bob" }, proposal.record.id), /unavailable/i);
    const dismissed = engine.dismiss(actor, proposal.record.id, proposal.record.revision);
    assert.equal(dismissed.status, "dismissed");
    assert.throws(
      () => engine.dismiss(actor, proposal.record.id, proposal.record.revision),
      /changed/i,
    );
    assert.deepEqual(f.teaching.resolve(actor, scope), []);
  } finally {
    f.close();
  }
});

test("an already-aborted proposal never invokes the model", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Improve",
      rating: -1,
      example: { prompt: "Question", response: "Answer" },
    });
    const engine = f.make({
      async suggestImprovement() {
        calls += 1;
        return { title: "No", instructions: "No", rationale: "No" };
      },
      async previewImprovement() {
        calls += 1;
        return { reply: "No" };
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      engine.propose(actor, {
        feedback: [{ id: feedback.id, revision: feedback.revision }],
        signal: controller.signal,
      }),
      (error) => error instanceof LifeImprovementError && error.code === "cancelled",
    );
    assert.equal(calls, 0);
    assert.equal(await engine.settleActive(), true);
  } finally {
    f.close();
  }
});

test("model schema and transport failures retain distinct actionable engine codes", async () => {
  const f = fixture();
  try {
    const feedback = f.learning.record(actor, {
      scope,
      message: "Improve",
      rating: -1,
      example: { prompt: "Question", response: "Answer" },
    });
    const reference = [{ id: feedback.id, revision: feedback.revision }];
    const failure = (code: "invalid_response" | "transport") =>
      Object.assign(new Error("internal model detail"), {
        name: "LifeModelImprovementError",
        code,
      });
    const invalid = f.make({
      async suggestImprovement() {
        throw failure("invalid_response");
      },
      async previewImprovement() {
        return { reply: "unused" };
      },
    });
    await assert.rejects(
      invalid.propose(actor, { feedback: reference }),
      (error) =>
        error instanceof LifeImprovementError &&
        error.code === "invalid_candidate" &&
        /valid improvement candidate/i.test(error.message),
    );
    const offline = f.make({
      async suggestImprovement() {
        throw failure("transport");
      },
      async previewImprovement() {
        return { reply: "unused" };
      },
    });
    await assert.rejects(
      offline.propose(actor, { feedback: reference }),
      (error) =>
        error instanceof LifeImprovementError &&
        error.code === "model_transport" &&
        /local model is unavailable/i.test(error.message),
    );
    assert.deepEqual(offline.list(actor), []);
  } finally {
    f.close();
  }
});
