import assert from "node:assert/strict";
import test from "node:test";
import type { SpeechInput } from "@ellie/speech";
import { NativeAuth, type NativeClient } from "../apps/server/src/native-auth.ts";
import { NativeSpeech, NativeSpeechError } from "../apps/server/src/native-speech.ts";

const token = (value: string) => value.repeat(64);
async function* bytes() {
  yield new Uint8Array([1]);
}
async function fixture(
  input: SpeechInput,
  persist: (value: unknown) => Promise<void> = async () => {},
) {
  const ids = ["invitation", "client"];
  const auth = new NativeAuth(NativeAuth.empty(), async () => {}, {
    id: () => ids.shift()!,
    token: () => token("a"),
  });
  const invitation = await auth.invite({
    label: "Phone",
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const client = await auth.pair(invitation.code, token("b"));
  const speech = NativeSpeech.memory(auth, input, persist);
  return { auth, client, speech, bearer: `Bearer ${token("b")}` };
}
const immediate = (text = "Editable transcript") =>
  ({
    async *transcribe(audio: AsyncIterable<Uint8Array>) {
      let size = 0;
      for await (const bytes of audio) size += bytes.length;
      assert.ok(size > 0);
      yield { text, final: true };
    },
  }) satisfies SpeechInput;

test("speech requires its independent grant and returns one bounded transcript", async () => {
  const f = await fixture(immediate());
  await assert.rejects(
    f.speech.transcribe(
      f.bearer,
      "11111111-1111-4111-8111-111111111111",
      bytes(),
      new AbortController().signal,
    ),
    (error) => error instanceof NativeSpeechError && error.kind === "forbidden",
  );
  assert.equal(
    await f.speech.grant({ clientId: f.client.id, capability: "speech.transcribe" }),
    true,
  );
  assert.deepEqual(f.speech.list(), [{ clientId: f.client.id, capability: "speech.transcribe" }]);
  assert.equal(
    await f.speech.transcribe(
      f.bearer,
      "11111111-1111-4111-8111-111111111111",
      bytes(),
      new AbortController().signal,
    ),
    "Editable transcript",
  );
  assert.ok(f.auth.authenticateBearer(f.bearer)?.grants[0]?.capabilities.includes("app.open"));
});

test("speech and session revocation cancel an active owned turn", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gated: SpeechInput = {
    async *transcribe(_audio, signal) {
      yield* [];
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("stopped");
    },
  };
  const f = await fixture(gated);
  await f.speech.grant({ clientId: f.client.id, capability: "speech.transcribe" });
  const turn = f.speech.transcribe(
    f.bearer,
    "22222222-2222-4222-8222-222222222222",
    bytes(),
    new AbortController().signal,
  );
  await entered;
  assert.equal(await f.speech.revoke(f.client.id), true);
  await assert.rejects(
    turn,
    (error) => error instanceof NativeSpeechError && error.kind === "cancelled",
  );

  let secondStarted!: () => void;
  const second = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const sessionInput: SpeechInput = {
    async *transcribe(_audio, signal) {
      yield* [];
      secondStarted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("stopped");
    },
  };
  const session = await fixture(sessionInput);
  await session.speech.grant({ clientId: session.client.id, capability: "speech.transcribe" });
  const original = session.speech.transcribe(
    session.bearer,
    "33333333-3333-4333-8333-333333333333",
    bytes(),
    new AbortController().signal,
  );
  await second;
  await session.auth.revoke(session.client.id);
  await assert.rejects(
    original,
    (error) => error instanceof NativeSpeechError && error.kind === "cancelled",
  );
});

test("failed grant persistence poisons speech authority without changing native app grants", async () => {
  const f = await fixture(immediate(), async () => {
    throw new Error("synthetic");
  });
  await assert.rejects(
    f.speech.grant({ clientId: f.client.id, capability: "speech.transcribe" }),
    (error) => error instanceof NativeSpeechError && error.kind === "unavailable",
  );
  assert.throws(
    () => f.speech.list(),
    (error) => error instanceof NativeSpeechError && error.kind === "unavailable",
  );
  assert.ok(f.auth.authenticateBearer(f.bearer));
});

test("owned explicit cancellation stops one turn without replay", async () => {
  let calls = 0,
    started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const input: SpeechInput = {
    async *transcribe(_audio, signal) {
      yield* [];
      calls += 1;
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("stopped");
    },
  };
  const f = await fixture(input);
  await f.speech.grant({ clientId: f.client.id, capability: "speech.transcribe" });
  const id = "44444444-4444-4444-8444-444444444444";
  const turn = f.speech.transcribe(f.bearer, id, bytes(), new AbortController().signal);
  await entered;
  assert.equal(await f.speech.cancel(f.bearer, id), true);
  await assert.rejects(
    turn,
    (error) => error instanceof NativeSpeechError && error.kind === "cancelled",
  );
  assert.equal(await f.speech.cancel(f.bearer, id), false);
  assert.equal(calls, 1);
});

test("speech close aborts and drains active turn cleanup", async () => {
  let started!: () => void,
    cleaned = false;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const input: SpeechInput = {
    async *transcribe(_audio, signal) {
      yield* [];
      try {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("stopped");
      } finally {
        cleaned = true;
      }
    },
  };
  const f = await fixture(input);
  await f.speech.grant({ clientId: f.client.id, capability: "speech.transcribe" });
  const turn = f.speech.transcribe(
    f.bearer,
    "55555555-5555-4555-8555-555555555555",
    bytes(),
    new AbortController().signal,
  );
  await entered;
  await f.speech.close();
  assert.equal(cleaned, true);
  await assert.rejects(
    turn,
    (error) => error instanceof NativeSpeechError && error.kind === "cancelled",
  );
});

test("speech cancellation while publication waits never returns a transcript", async (t) => {
  for (const reason of ["disconnect", "explicit cancel", "after authorization"] as const) {
    await t.test(reason, { timeout: 2000 }, async () => {
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      const inputStarted = deferred();
      const finishInput = deferred();
      const publicationQueued = deferred();
      const lockEntered = deferred();
      const releaseLock = deferred();
      const disconnected = new AbortController();
      let calls = 0;
      const f = await fixture({
        async *transcribe() {
          calls += 1;
          inputStarted.resolve();
          await finishInput.promise;
          yield { text: "A completed synthetic transcript", final: true };
        },
      });
      await f.speech.grant({ clientId: f.client.id, capability: "speech.transcribe" });
      const original = f.auth.withAuthenticated.bind(f.auth);
      let observePublication = false;
      f.auth.withAuthenticated = async <T>(
        header: unknown,
        work: (client: NativeClient) => Promise<T> | T,
      ) => {
        const publication = observePublication;
        if (publication) publicationQueued.resolve();
        const result = await original(header, work);
        if (publication && reason === "after authorization") disconnected.abort();
        return result;
      };
      const id = "66666666-6666-4666-8666-666666666666";
      const turn = f.speech.transcribe(f.bearer, id, bytes(), disconnected.signal);
      const rejected = assert.rejects(
        turn,
        (error) => error instanceof NativeSpeechError && error.kind === "cancelled",
      );
      await inputStarted.promise;
      // Hold the real authorization lock while inference finishes. Cancellation
      // is queued ahead of publication, or arrives through the live request signal.
      const held = f.auth.withActiveClient(f.client.id, async () => {
        lockEntered.resolve();
        await releaseLock.promise;
      });
      try {
        await lockEntered.promise;
        const cancelled = reason === "explicit cancel" ? f.speech.cancel(f.bearer, id) : undefined;
        observePublication = true;
        finishInput.resolve();
        await publicationQueued.promise;
        if (reason === "disconnect") disconnected.abort();
        releaseLock.resolve();
        await held;
        if (cancelled) assert.equal(await cancelled, true);
        await rejected;
        assert.equal(calls, 1);
      } finally {
        releaseLock.resolve();
        finishInput.resolve();
        await held;
        await f.speech.close();
      }
    });
  }
});
