import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CAPABILITIES, job, record } from "@ellie/protocol";
import { LocalDecisionProvider } from "@ellie/decisions";
import type { DecisionProvider, DecisionRequest, DecisionResponse } from "@ellie/decisions";
import { fixture } from "./helpers.ts";

function answer(request: DecisionRequest): DecisionResponse {
  const choices: Record<string, string> = {
    request: "single",
    operation: "app.open",
    app: "app_3",
  };
  const answers: DecisionResponse["answers"] = {};
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type !== "choice") throw new Error("Expected choices");
    const choice = choices[key] ?? "none";
    answers[key] = {
      type: "choice",
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(
        Object.keys(question.criteria).map((option) => [option, Number(option === choice)]),
      ),
    };
  }
  return { model: "synthetic", answers, latencyMs: 1 };
}

function stub(
  evaluate: (request: DecisionRequest) => Promise<DecisionResponse> = async (request) =>
    answer(request),
): DecisionProvider {
  return { id: "synthetic", locality: "local", evaluate };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a real loopback decision response passes through HTTPS routing without execution in shadow", async () => {
  let received = 0;
  const runner = createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(body.model, "synthetic-local");
      const payload = JSON.parse(body.messages[1].content);
      assert.equal(payload.state.input, "Bring up Notes");
      received++;
      const judged = answer({ ...payload, signal: new AbortController().signal });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          model: "synthetic-local",
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ answers: judged.answers }) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      );
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const port = (runner.address() as AddressInfo).port;
  const f = await fixture(2000, {
    decisionRouting: {
      mode: "shadow",
      provider: new LocalDecisionProvider({
        endpoint: `http://127.0.0.1:${port}`,
        model: "synthetic-local",
      }),
    },
  });
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const response = record(
      await f.controller.call("POST", "/v1/commands", { nodeId: "node", text: "Bring up Notes" }),
    );
    assert.match(String(response.message), /Shadow mode.*com.apple.Notes/);
    assert.equal(received, 1);
    assert.deepEqual(f.jobStore.list(), []);
  } finally {
    await f.close();
    runner.closeAllConnections();
    await new Promise<void>((resolve) => runner.close(() => resolve()));
  }
});

test("shadow routing shows a candidate without jobs, execution, or pronoun changes", async () => {
  const requests: DecisionRequest[] = [];
  const f = await fixture(2000, {
    decisionRouting: {
      mode: "shadow",
      provider: stub(async (request) => {
        requests.push(request);
        return answer(request);
      }),
    },
  });
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const result = record(
      await f.controller.call("POST", "/v1/commands", { nodeId: "node", text: "Bring up Notes" }),
    );
    assert.equal(result.ok, false);
    assert.match(String(result.message), /Shadow mode.*com.apple.Notes.*No action was executed/);
    assert.deepEqual(f.jobStore.list(), []);
    await f.controller.call("POST", "/v1/commands", {
      nodeId: "node",
      text: "Bring up Notes",
    });
    assert.equal(record(requests[1]?.state).lastApp, null);
  } finally {
    await f.close();
  }
});

test("known commands bypass the decision provider even in execute mode", async () => {
  let calls = 0;
  const f = await fixture(2000, {
    decisionRouting: {
      mode: "execute",
      provider: stub(async () => {
        calls++;
        throw new Error("Unavailable");
      }),
    },
  });
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const response = f.controller.call("POST", "/v1/commands", {
      nodeId: "node",
      text: "open Arc",
    });
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    await node.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Done." } });
    assert.equal(record(await response).ok, true);
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("execute routing uses ordinary jobs and commits context only after success", async () => {
  const f = await fixture(2000, { decisionRouting: { mode: "execute", provider: stub() } });
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const response = f.controller.call("POST", "/v1/commands", {
      nodeId: "node",
      text: "Bring up Notes",
    });
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    assert.deepEqual(task.actions, [{ tool: "app.open", app: "com.apple.Notes" }]);
    await node.call("POST", "/v1/start", { id: task.id });
    await node.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Done." } });
    assert.equal(record(await response).ok, true);
    const followup = f.controller.call("POST", "/v1/commands", {
      nodeId: "node",
      text: "put it in the top-left",
    });
    const placement = job(record(await node.call("GET", "/v1/poll")).job);
    assert.equal(placement.actions[0]?.app, "com.apple.Notes");
    await node.call("POST", "/v1/result", {
      id: placement.id,
      result: { ok: true, message: "Done." },
    });
    assert.equal(record(await followup).ok, true);
  } finally {
    await f.close();
  }
});

test("decision proposals cannot bypass advertised node capabilities", async () => {
  const f = await fixture(2000, { decisionRouting: { mode: "execute", provider: stub() } });
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: ["window.place"] });
    const result = record(
      await f.controller.call("POST", "/v1/commands", { nodeId: "node", text: "Bring up Notes" }),
    );
    assert.equal(result.ok, false);
    assert.match(String(result.message), /No action was sent/);
    assert.deepEqual(f.jobStore.list(), []);
  } finally {
    await f.close();
  }
});

test("an in-flight decision reserves its node slot but allows another node to work", async () => {
  const entered = deferred<DecisionRequest>();
  const release = deferred<void>();
  const f = await fixture(2000, {
    decisionRouting: {
      mode: "shadow",
      provider: stub(async (request) => {
        entered.resolve(request);
        await release.promise;
        return answer(request);
      }),
    },
  });
  try {
    const a = await f.pair("node-a");
    const b = await f.pair("node-b");
    for (const node of [a, b])
      await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const response = f.controller.call("POST", "/v1/commands", {
      nodeId: "node-a",
      text: "Bring up Notes",
    });
    await entered.promise;
    await assert.rejects(
      f.controller.call("POST", "/v1/commands", { nodeId: "node-a", text: "open Arc" }),
      /busy/,
    );
    const other = f.controller.call("POST", "/v1/commands", { nodeId: "node-b", text: "open Arc" });
    const task = job(record(await b.call("GET", "/v1/poll")).job);
    await b.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Done." } });
    assert.equal(record(await other).ok, true);
    release.resolve();
    assert.match(String(record(await response).message), /Shadow/);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("server deadline releases the slot even if a decision provider ignores cancellation", async () => {
  const f = await fixture(2000, {
    decisionRouting: {
      mode: "execute",
      timeoutMs: 30,
      provider: stub(async () => new Promise(() => {})),
    },
  });
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const response = record(
      await f.controller.call("POST", "/v1/commands", { nodeId: "node", text: "Bring up Notes" }),
    );
    assert.equal(response.ok, false);
    assert.deepEqual(f.jobStore.list(), []);
    const retry = f.controller.call("POST", "/v1/commands", { nodeId: "node", text: "open Arc" });
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    await node.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Done." } });
    assert.equal(record(await retry).ok, true);
  } finally {
    await f.close();
  }
});

for (const change of ["revoke", "register", "disconnect"] as const) {
  test(`${change} during routing prevents a late proposal from executing`, async () => {
    const entered = deferred<DecisionRequest>();
    const release = deferred<void>();
    const f = await fixture(2000, {
      decisionRouting: {
        mode: "execute",
        provider: stub(async (request) => {
          entered.resolve(request);
          await release.promise;
          return answer(request);
        }),
      },
    });
    try {
      const node = await f.pair("node");
      await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
      const abort = new AbortController();
      const response = f.controller
        .call(
          "POST",
          "/v1/commands",
          { nodeId: "node", text: "Bring up Notes" },
          { signal: abort.signal },
        )
        .catch(() => undefined);
      const request = await entered.promise;
      if (change === "revoke") await f.controller.call("POST", "/v1/revoke", { id: "node" });
      else if (change === "register") await node.call("POST", "/v1/register", { capabilities: [] });
      else abort.abort();
      // Wait for server-side close processing before releasing the deliberately uncooperative provider.
      if (!request.signal.aborted)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      release.resolve();
      await response;
      await delay(10);
      assert.deepEqual(f.jobStore.list(), []);
    } finally {
      release.resolve();
      await f.close();
    }
  });
}
