import assert from "node:assert/strict";
import test from "node:test";
import { LocalOpenAIModel } from "../packages/life-harness/src/model.ts";

const plugin = (name: string) =>
  Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({ name, description: "Fixture", html: "<p>Fixture</p>" }),
        },
      },
    ],
  });
const plan = Response.json({
  choices: [{ message: { content: JSON.stringify({ reply: "Ready", actions: [] }) } }],
});

test("one active inference prioritizes queued chat over background generation", async () => {
  let releaseFirst!: (response: Response) => void;
  const order: string[] = [];
  let calls = 0;
  const model = new LocalOpenAIModel(
    "http://127.0.0.1:8080/v1",
    "fixture",
    async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> },
        last = body.messages.at(-1)!.content;
      order.push(last.includes('"message"') ? "plan" : `build-${JSON.parse(last).request}`);
      if (calls === 1)
        return await new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      return order.at(-1) === "plan" ? plan.clone() : plugin("Second");
    },
    { timeoutMs: 1_000, buildTimeoutMs: 1_000 },
  );
  const first = model.build("first"),
    second = model.build("second");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const foreground = model.plan({ message: "hello", history: [], evidence: [] });
  assert.deepEqual(order, ["build-first"]);
  releaseFirst(plugin("First"));
  assert.equal((await first).name, "First");
  assert.equal((await foreground).reply, "Ready");
  assert.equal((await second).name, "Second");
  assert.deepEqual(order, ["build-first", "plan", "build-second"]);
});

test("schema repair keeps foreground priority over an already queued build", async () => {
  let releaseInitial!: (response: Response) => void;
  const order: string[] = [];
  let calls = 0;
  const model = new LocalOpenAIModel(
    "http://127.0.0.1:8080/v1",
    "fixture",
    async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> },
        last = body.messages.at(-1)!.content;
      order.push(
        last.includes("outputRepair") ? "repair" : last.includes('"message"') ? "plan" : "build",
      );
      if (calls === 1)
        return await new Promise<Response>((resolve) => {
          releaseInitial = resolve;
        });
      return order.at(-1) === "repair" ? plan.clone() : plugin("Background");
    },
    { timeoutMs: 1_000, buildTimeoutMs: 1_000 },
  );
  const foreground = model.plan({ message: "hello", history: [], evidence: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const background = model.build("background");
  releaseInitial(Response.json({ choices: [{ message: { content: "invalid plan" } }] }));
  assert.equal((await foreground).reply, "Ready");
  assert.equal((await background).name, "Background");
  assert.deepEqual(order, ["plan", "repair", "build"]);
});

test("queued abort and deadline remove work before transport dispatch", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const model = new LocalOpenAIModel(
    "http://127.0.0.1:8080/v1",
    "fixture",
    async () => {
      calls++;
      return await new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
    { timeoutMs: 15, buildTimeoutMs: 1_000 },
  );
  const active = model.build("hold");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController(),
    cancelled = model.plan({ message: "cancel me", history: [], evidence: [] }, controller.signal);
  controller.abort(new Error("cancelled while queued"));
  await assert.rejects(cancelled, /cancelled while queued/);
  await assert.rejects(
    model.plan({ message: "deadline", history: [], evidence: [] }),
    /deadline exceeded/,
  );
  assert.equal(calls, 1);
  release(plugin("Held"));
  await active;
});

test("unsettled active transport retains its slot and bounds the queue", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const model = new LocalOpenAIModel(
    "http://127.0.0.1:8080/v1",
    "fixture",
    async () => {
      calls++;
      return await new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
    { timeoutMs: 1_000, buildTimeoutMs: 1_000 },
  );
  const active = model.build("hold");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controllers = Array.from({ length: 3 }, () => new AbortController()),
    queued = controllers.map((controller, index) =>
      model.plan({ message: `queued ${index}`, history: [], evidence: [] }, controller.signal),
    );
  await assert.rejects(model.plan({ message: "overflow", history: [], evidence: [] }), /busy/);
  assert.equal(calls, 1);
  controllers.forEach((controller) => controller.abort(new Error("test cleanup")));
  await Promise.all(queued.map((work) => assert.rejects(work, /test cleanup/)));
  release(plugin("Held"));
  await active;
});
