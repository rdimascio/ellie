import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";
import {
  createLifeHarness,
  LocalOpenAIModel,
  type LifeModel,
} from "../packages/life-harness/src/index.ts";
import { isDirectPlanRequest } from "../packages/life-harness/src/direct-plan-request.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

const actor = { userId: "planning-quality" };
const scope = { type: "user", id: actor.userId } as const;
const compoundRequest =
  "Help me tidy the kitchen. Make a checklist with exactly two items: wipe the counter, then take out the recycling.";
const directRequest =
  "Make a checklist for tidying the kitchen with exactly two items: wipe the counter and take out the recycling.";

const createPlan = {
  reply: "I'll save that checklist.",
  actions: [
    {
      type: "life_operation" as const,
      intent: {
        kind: "create_plan" as const,
        title: "Tidy the kitchen",
        steps: ["Wipe the counter", "Take out the recycling"],
      },
    },
  ],
};

test("direct plan classification is conservative across sentence boundaries", () => {
  for (const message of [
    compoundRequest,
    "I'm tidying the kitchen. Make a checklist for the remaining work.",
    directRequest,
    "Could you please create a plan for tidying the kitchen?",
  ])
    assert.equal(isDirectPlanRequest(message), true, message);
  for (const message of [
    'Quote "Make a checklist for tidying the kitchen."',
    "My manager said. Make a checklist for tidying the kitchen.",
    "My manager said this. Make a checklist for tidying the kitchen.",
    "The instruction was written as follows. Make a checklist for tidying the kitchen.",
    "Do not make a checklist for tidying the kitchen.",
    "Never make a checklist for tidying the kitchen.",
    "Make a checklist for tidying the kitchen. Do not save any plan.",
    "Make a checklist for tidying the kitchen, but don't save it.",
    "Make a checklist for tidying the kitchen. Do not save anything.",
    "```\nMake a checklist for tidying the kitchen.\n```",
    "> Context. Make a checklist for tidying the kitchen.",
  ])
    assert.equal(isDirectPlanRequest(message), false, message);
});

test("a valid prose-only direct-plan response gets one bounded schema repair", async () => {
  const requests: Array<{ messages: Array<{ content: string }> }> = [];
  const responses = [{ reply: "Here is a two-item checklist in prose.", actions: [] }, createPlan];
  const model = new LocalOpenAIModel(
    "http://127.0.0.1:8080/v1",
    "planning-quality",
    async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      });
    },
  );
  assert.deepEqual(
    await model.plan({ message: compoundRequest, evidence: [], history: [] }),
    createPlan,
  );
  assert.equal(requests.length, 2);
  assert.equal(
    JSON.parse(requests[1]!.messages.at(-1)!.content).outputRepair.reason,
    "missing-create-plan",
  );
  assert.equal(JSON.parse(requests[1]!.messages.at(-1)!.content).message, compoundRequest);
  assert.match(requests[1]!.messages[0]!.content, /"kind":"create_plan"/);
});

test("a second prose-only response fails explicitly after exactly one repair", async () => {
  let calls = 0;
  const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "planning-quality", async () => {
    calls += 1;
    return Response.json({
      choices: [
        { message: { content: JSON.stringify({ reply: "A prose checklist.", actions: [] }) } },
      ],
    });
  });
  await assert.rejects(
    model.plan({ message: compoundRequest, evidence: [], history: [] }),
    /directly requested checklist was not saved/i,
  );
  assert.equal(calls, 2);
});

test("the captured flattened create-plan repair stays rejected without another retry", async () => {
  let calls = 0;
  const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "planning-quality", async () => {
    calls += 1;
    const response =
      calls === 1
        ? { reply: "Here is a two-item checklist in prose.", actions: [] }
        : {
            reply: "I've created a two-item checklist.",
            actions: [
              {
                type: "create_plan",
                title: "Tidy the kitchen",
                steps: ["Wipe the counter", "Take out the recycling"],
              },
            ],
          };
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
  });
  await assert.rejects(
    model.plan({ message: compoundRequest, evidence: [], history: [] }),
    /Invalid model action/,
  );
  assert.equal(calls, 2);
});

test("clarification and clear inability remain bounded no-write responses", async () => {
  for (const response of [
    {
      reply: "Which kitchen should this checklist cover?",
      actions: [
        {
          type: "life_operation",
          intent: { kind: "clarify", question: "Which kitchen?", missing: ["scope"] },
        },
      ],
    },
    { reply: "I cannot save a checklist right now.", actions: [] },
  ]) {
    let calls = 0;
    const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "planning-quality", async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
    });
    assert.deepEqual(
      await model.plan({ message: compoundRequest, evidence: [], history: [] }),
      response,
    );
    assert.equal(calls, 1);
  }
});

test("refusal and clarification cannot conceal a different mutation", async () => {
  for (const response of [
    {
      reply: "I cannot save a checklist.",
      actions: [{ type: "reply", text: "Saved it." }],
    },
    {
      reply: "Which kitchen?",
      actions: [
        {
          type: "life_operation",
          intent: { kind: "clarify", question: "Which kitchen?", missing: ["scope"] },
        },
        {
          type: "life_operation",
          intent: { kind: "create_need", title: "Buy cleaner" },
        },
      ],
    },
  ]) {
    let calls = 0;
    const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "planning-quality", async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
    });
    await assert.rejects(
      model.plan({ message: compoundRequest, evidence: [], history: [] }),
      /directly requested checklist was not saved/i,
    );
    assert.equal(calls, 2);
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ellie-planning-quality-"));
  await chmod(root, 0o700);
  const lifeDirectory = join(root, "life");
  const pluginDirectory = join(root, "plugins");
  const taskDirectory = join(root, "tasks");
  for (const directory of [lifeDirectory, pluginDirectory, taskDirectory])
    await mkdir(directory, { mode: 0o700 });
  const store = new LifeStore(join(lifeDirectory, "life.sqlite"));
  const plugins = new PluginStore(join(pluginDirectory, "plugins.sqlite"));
  const tasks = new TaskRuntime({ directory: taskDirectory });
  return {
    store,
    make(model: LifeModel) {
      return createLifeHarness({ store, plugins, tasks, model, mlb: new MLBAdapter() });
    },
    async close() {
      await tasks.close();
      plugins.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("host authorization saves captured direct plans and rejects quoted or negated mutations", async () => {
  const f = await fixture();
  let planned = createPlan;
  const model: LifeModel = {
    async plan() {
      return structuredClone(planned);
    },
  };
  try {
    const harness = f.make(model);
    await harness.chat({ actor, scope, message: compoundRequest });
    const created = harness.plans.find(actor, scope, "Tidy the kitchen");
    assert.deepEqual(
      created.steps.map((step) => step.title),
      ["Wipe the counter", "Take out the recycling"],
    );

    for (const message of [
      'Quote "Make a checklist for tidying the garage."',
      "I said. Make a checklist for tidying the garage.",
      "My manager said this. Make a checklist for tidying the garage.",
      "Do not make a checklist for tidying the garage.",
      "Make a checklist for tidying the garage. Do not save any plan.",
      "Make a checklist for tidying the garage, but don’t save it.",
    ]) {
      planned = {
        ...createPlan,
        actions: [
          {
            type: "life_operation",
            intent: { kind: "create_plan", title: "Tidy the garage", steps: ["Sweep"] },
          },
        ],
      };
      const response = await harness.chat({ actor, scope, message });
      assert.match(response.reply, /direct request/i);
    }
    assert.equal(harness.plans.list(actor, { scope }).plans.length, 1);
  } finally {
    await f.close();
  }
});

test("bounded model repair reaches host persistence for both captured request forms", async () => {
  for (const message of [compoundRequest, directRequest]) {
    const f = await fixture();
    let calls = 0;
    const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "planning-quality", async () => {
      calls += 1;
      const response =
        calls === 1 ? { reply: "Here is a two-item checklist in prose.", actions: [] } : createPlan;
      return Response.json({
        choices: [{ message: { content: JSON.stringify(response) } }],
      });
    });
    try {
      const harness = f.make(model);
      const response = await harness.chat({ actor, scope, message });
      assert.match(response.reply, /Created plan.*2 steps/i);
      assert.equal(calls, 2);
      const plans = harness.plans.list(actor, { scope }).plans;
      assert.equal(plans.length, 1);
      assert.deepEqual(
        plans[0]!.steps.map((step) => step.title),
        ["Wipe the counter", "Take out the recycling"],
      );
    } finally {
      await f.close();
    }
  }
});
