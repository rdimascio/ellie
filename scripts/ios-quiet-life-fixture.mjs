/**
 * Synthetic durable Quiet data for the existing pinned iOS Life HTTPS fixture.
 * The production LifeStore, TaskRuntime, Life server, and native authority stay in use.
 * No provider, model service, account, or household process is contacted.
 */
export async function createIOSQuietLifeFixture({ life, tasks, actorId }) {
  const actor = { userId: actorId };
  const scope = { type: "user", id: actorId };
  const source = life.createRecord(actor, {
    id: "quiet.source:album@fixture/one",
    kind: "source",
    title: "Family album register 👩‍👩‍👧‍👧",
    body: "Three albums checked in the synthetic fixture.",
    scope,
    data: {},
  });
  tasks.registerHandler({
    name: "quiet.ios.verified",
    async run(context) {
      context.progress({ message: "Checked the album register" });
      return {
        status: "complete",
        summary: "Three albums verified.",
        citations: [
          {
            sourceId: source.id,
            sourceRevision: source.revision,
            title: source.title,
            references: [],
          },
        ],
      };
    },
    checkOutcome: () => true,
  });
  const task = tasks.enqueue({
    id: "quiet.task:album@fixture/one",
    owner: `user:${actorId}`,
    handler: "quiet.ios.verified",
  });
  await tasks.runNow(task.id, `user:${actorId}`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && tasks.get(task.id, `user:${actorId}`)?.state !== "succeeded")
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (tasks.get(task.id, `user:${actorId}`)?.state !== "succeeded")
    throw new Error("Synthetic Quiet task did not reach a verified terminal result.");
  const begun = life.beginConversationTurn(actor, {
    scope,
    requestId: "quiet-ios-seeded-turn",
    chatEpoch: life.chatEpoch(actor),
    message: "Review the family albums 👩‍👩‍👧‍👧",
  });
  life.completeConversationTurn(actor, {
    conversationId: begun.conversation.id,
    turnId: begun.turn.id,
    requestId: "quiet-ios-seeded-turn",
    result: {
      reply: "The review is ready.",
      actions: [],
      recordIds: [],
      taskIds: [task.id],
      evidence: [],
    },
  });

  let armDetail = false;
  let detailRelease;
  let detailStarted = 0;
  let detailSettled = 0;
  let armChatResponse = false;
  let chatResponseRelease;
  let chatResponseHeld = 0;
  let chatResponseReleased = 0;
  let nativeChatPosts = 0;
  const detailPath = `/api/life/native/sessions/${begun.conversation.id}`;

  return {
    sessionID: begun.conversation.id,
    taskID: task.id,
    control: {
      armDetail() {
        armDetail = true;
      },
      releaseDetail() {
        const release = detailRelease;
        detailRelease = undefined;
        release?.();
      },
      detailStarted: () => detailStarted,
      detailSettled: () => detailSettled,
      armChatResponse() {
        armChatResponse = true;
      },
      releaseChatResponse() {
        const release = chatResponseRelease;
        chatResponseRelease = undefined;
        release?.();
      },
      chatResponseHeld: () => chatResponseHeld,
      chatResponseReleased: () => chatResponseReleased,
      nativeChatPosts: () => nativeChatPosts,
      durableTurns: () => life.listConversations(actor, { scope }).items.length,
    },
    async handle(request, response, perform) {
      const path = request.url?.split("?", 1)[0] ?? "";
      const heldDetail = request.method === "GET" && path === detailPath && armDetail;
      if (heldDetail) {
        armDetail = false;
        detailStarted += 1;
        await new Promise((resolve) => {
          detailRelease = resolve;
        });
      }
      if (request.method === "POST" && path === "/api/life/native/chat") {
        nativeChatPosts += 1;
        if (armChatResponse) {
          armChatResponse = false;
          const originalEnd = response.end;
          response.end = function (...args) {
            response.end = originalEnd;
            chatResponseHeld += 1;
            chatResponseRelease = () => {
              chatResponseReleased += 1;
              originalEnd.apply(response, args);
            };
            return response;
          };
        }
      }
      try {
        return await perform();
      } finally {
        if (heldDetail) detailSettled += 1;
      }
    },
    releaseAll() {
      const releaseDetail = detailRelease;
      detailRelease = undefined;
      releaseDetail?.();
      const releaseChat = chatResponseRelease;
      chatResponseRelease = undefined;
      releaseChat?.();
    },
  };
}
