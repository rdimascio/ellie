import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFE_PLAN_INSTRUCTIONS,
  PLAN_MESSAGE_BYTE_LIMIT,
  planMessages,
} from "../packages/life-harness/src/model-context.ts";
import { LocalOpenAIModel, type LifeModelProgress } from "../packages/life-harness/src/model.ts";

function eventStream(parts: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

test("planning prompt keeps stable instructions compact and bounded", () => {
  const messages = planMessages({
    message: "Help me make a plan for dinner.",
    history: [],
    evidence: [],
    automaticMemory: {
      markdown: "# Remembered user statements\n- Statement or preference: I like soup.",
      revision: "a".repeat(64),
      partial: false,
    },
  });
  assert.ok(Buffer.byteLength(LIFE_PLAN_INSTRUCTIONS, "utf8") < 9_000);
  assert.ok(Buffer.byteLength(JSON.stringify(messages), "utf8") < 12_000);
  assert.ok(Buffer.byteLength(JSON.stringify(messages), "utf8") <= PLAN_MESSAGE_BYTE_LIMIT);
});

test("SSE streams only decoded reply snapshots and validates the final plan", async () => {
  const encoder = new TextEncoder(),
    payload =
      '{"reply":"Hello 🌿","actions":[{"type":"create_memory","title":"private-action","body":"never preview this"}]}',
    deltas = ['{"reply":"Hel', "lo 🌿", payload.slice('{"reply":"Hello 🌿'.length)],
    events = [
      ...deltas.map(
        (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ],
    bytes = encoder.encode(events.join("")),
    split = bytes.indexOf(0xf0) + 2,
    progress: LifeModelProgress[] = [],
    model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "fixture", async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      assert.equal(body.stream, true);
      return eventStream([bytes.slice(0, split), bytes.slice(split)]);
    });
  const plan = await model.plan(
    { message: "Remember this", history: [], evidence: [] },
    undefined,
    (event) => progress.push(event),
  );
  assert.equal(plan.reply, "Hello 🌿");
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(progress[0], { phase: "queued" });
  assert.ok(progress.some((event) => event.phase === "drafting" && event.text === "Hello 🌿"));
  assert.equal(progress.at(-1)?.phase, "validating");
  assert.doesNotMatch(JSON.stringify(progress), /private-action|never preview/);
});

test("truncated SSE is rejected and callback failures cannot alter inference", async () => {
  let calls = 0;
  const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "fixture", async () => {
    calls++;
    if (calls === 1)
      return eventStream([
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reply":"Draft"' } }] })}\n\n`,
        ),
      ]);
    return Response.json({
      choices: [{ message: { content: '{"reply":"Final","actions":[]}' } }],
    });
  });
  await assert.rejects(
    model.plan({ message: "Hello", history: [], evidence: [] }, undefined, () => {
      throw new Error("UI callback failure");
    }),
    /Truncated local model event stream/,
  );
  assert.equal(calls, 1, "transport truncation must not trigger schema repair");
});
