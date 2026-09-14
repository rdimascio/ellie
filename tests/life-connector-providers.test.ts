import assert from "node:assert/strict";
import test from "node:test";
import {
  GmailProvider,
  GoogleCalendarProvider,
  PlaidProvider,
} from "../packages/life-connectors/src/providers.ts";
import { ProviderError } from "../packages/life-connectors/src/provider-types.ts";

function mock(responses: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const signal = () => new AbortController().signal;

test("Google Calendar uses fixed incremental request shapes and exposes tombstones", async () => {
  const first = mock([
    { body: { id: "owner@example.test", summary: "Primary" } },
    {
      body: {
        items: [
          {
            id: "event-1",
            etag: "v1",
            summary: "Appointment",
            status: "confirmed",
            start: { dateTime: "2026-09-15T10:00:00-07:00", timeZone: "America/Los_Angeles" },
            end: { dateTime: "2026-09-15T11:00:00-07:00" },
          },
          { id: "event-2", etag: "v2", status: "cancelled", start: {}, end: {} },
        ],
        nextPageToken: "page-2",
      },
    },
  ]);
  const provider = new GoogleCalendarProvider({ fetch: first.fetch, now: () => 7 });
  const partial = await provider.pull({
    credential: { accessToken: "secret-token" },
    window: { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) },
    limit: 50,
    signal: signal(),
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.cursor, undefined);
  assert.equal(partial.items[1]?.kind, "deleted");
  const requestUrl = new URL(first.requests[1]!.url);
  assert.equal(requestUrl.origin, "https://www.googleapis.com");
  assert.equal(requestUrl.searchParams.get("showDeleted"), "true");
  assert.equal(requestUrl.searchParams.get("singleEvents"), "true");
  assert.ok(requestUrl.searchParams.has("timeMin"));
  assert.equal(
    first.requests[1]!.init?.headers &&
      (first.requests[1]!.init!.headers as Record<string, string>).authorization,
    "Bearer secret-token",
  );
  assert.equal(JSON.stringify(partial).includes("secret-token"), false);

  const second = mock([
    { body: { id: "owner@example.test" } },
    { body: { items: [], nextSyncToken: "sync-final" } },
  ]);
  const completed = await new GoogleCalendarProvider({ fetch: second.fetch }).pull({
    credential: { accessToken: "secret-token" },
    continuation: partial.continuation,
    // A broker retry happens later, but the opaque continuation owns the original window.
    window: { from: Date.UTC(2026, 7, 1), to: Date.UTC(2026, 10, 1) },
    limit: 50,
    signal: signal(),
  });
  assert.deepEqual(
    { complete: completed.complete, cursor: completed.cursor },
    { complete: true, cursor: "sync-final" },
  );
  const continuedUrl = new URL(second.requests[1]!.url);
  assert.equal(continuedUrl.searchParams.get("pageToken"), "page-2");
  assert.equal(continuedUrl.searchParams.get("timeMin"), requestUrl.searchParams.get("timeMin"));
  assert.equal(continuedUrl.searchParams.get("timeMax"), requestUrl.searchParams.get("timeMax"));
});

test("Gmail history requests metadata only and retains deletion evidence", async () => {
  const transport = mock([
    { body: { emailAddress: "owner@example.test", historyId: "20" } },
    {
      body: {
        historyId: "25",
        history: [
          {
            messagesAdded: [{ message: { id: "m-added" } }],
            messagesDeleted: [{ message: { id: "m-deleted" } }],
          },
        ],
      },
    },
    {
      body: {
        id: "m-added",
        threadId: "thread-1",
        historyId: "24",
        internalDate: "1789400000000",
        labelIds: ["INBOX"],
        snippet: "A bounded preview",
        payload: {
          headers: [
            { name: "From", value: "sender@example.test" },
            { name: "To", value: "owner@example.test" },
            { name: "Subject", value: "Metadata subject" },
          ],
        },
      },
    },
  ]);
  const result = await new GmailProvider({ fetch: transport.fetch, now: () => 9 }).pull({
    credential: { accessToken: "gmail-secret" },
    cursor: "20",
    window: { from: 1, to: 2 },
    limit: 50,
    signal: signal(),
  });
  assert.equal(result.cursor, "25");
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ["message", "deleted"],
  );
  const history = new URL(transport.requests[1]!.url);
  assert.equal(history.origin, "https://gmail.googleapis.com");
  assert.equal(history.searchParams.get("startHistoryId"), "20");
  const metadata = new URL(transport.requests[2]!.url);
  assert.equal(metadata.searchParams.get("format"), "metadata");
  assert.equal(metadata.searchParams.getAll("metadataHeaders").includes("Subject"), true);
  assert.equal(JSON.stringify(result).includes("gmail-secret"), false);
});

test("Gmail initial pagination retains the original bounded search window", async () => {
  const first = mock([
    { body: { emailAddress: "owner@example.test", historyId: "20" } },
    { body: { messages: [], nextPageToken: "gmail-page-2" } },
  ]);
  const partial = await new GmailProvider({ fetch: first.fetch }).pull({
    credential: { accessToken: "gmail-secret" },
    window: { from: 1_700_000_000_000, to: 1_800_000_000_000 },
    limit: 50,
    signal: signal(),
  });
  const originalQuery = new URL(first.requests[1]!.url).searchParams.get("q");
  const second = mock([
    { body: { emailAddress: "owner@example.test", historyId: "21" } },
    { body: { messages: [] } },
  ]);
  await new GmailProvider({ fetch: second.fetch }).pull({
    credential: { accessToken: "gmail-secret" },
    continuation: partial.continuation,
    window: { from: 1_600_000_000_000, to: 1_900_000_000_000 },
    limit: 50,
    signal: signal(),
  });
  const continued = new URL(second.requests[1]!.url);
  assert.equal(continued.searchParams.get("pageToken"), "gmail-page-2");
  assert.equal(continued.searchParams.get("q"), originalQuery);
});

test("Plaid sync uses fixed origin, exact decimal strings, and advances only complete cursor", async () => {
  const transport = mock([
    { body: { item: { item_id: "item-1", institution_id: "ins-1" } } },
    {
      body: {
        added: [
          {
            transaction_id: "tx-1",
            account_id: "account-1",
            amount: 12.34,
            iso_currency_code: "USD",
            date: "2026-09-14",
            merchant_name: "Market",
            pending: false,
          },
        ],
        modified: [],
        removed: [{ transaction_id: "tx-old" }],
        next_cursor: "cursor-2",
        has_more: false,
      },
    },
  ]);
  const result = await new PlaidProvider({
    fetch: transport.fetch,
    plaidEnvironment: "sandbox",
    now: () => 11,
  }).pull({
    credential: { accessToken: "plaid-token", clientId: "client", clientSecret: "secret" },
    cursor: "cursor-1",
    window: { from: 1, to: 2 },
    limit: 100,
    signal: signal(),
  });
  assert.equal(transport.requests[1]!.url, "https://sandbox.plaid.com/transactions/sync");
  assert.deepEqual(JSON.parse(String(transport.requests[1]!.init?.body)), {
    access_token: "plaid-token",
    client_id: "client",
    secret: "secret",
    cursor: "cursor-1",
    count: 100,
  });
  assert.equal(result.cursor, "cursor-2");
  assert.equal(result.items[0]?.kind, "transaction");
  if (result.items[0]?.kind === "transaction")
    assert.equal(result.items[0].data.amountDecimal, "12.34");
  assert.equal(result.items[1]?.kind, "deleted");
  assert.equal(JSON.stringify(result).includes("plaid-token"), false);
});

test("Plaid bounds combined changes and surfaces restart and not-ready states", async () => {
  const transaction = (id: string) => ({
    transaction_id: id,
    amount: 1,
    iso_currency_code: "USD",
    date: "2026-09-14",
    pending: false,
  });
  const overLimit = mock([
    { body: { item: { item_id: "item-1" } } },
    {
      body: {
        added: [transaction("one")],
        modified: [transaction("two")],
        removed: [],
        next_cursor: "next",
        has_more: false,
      },
    },
  ]);
  await assert.rejects(
    new PlaidProvider({ fetch: overLimit.fetch, plaidEnvironment: "sandbox" }).pull({
      credential: { accessToken: "token", clientId: "client", clientSecret: "secret" },
      window: { from: 1, to: 2 },
      limit: 1,
      signal: signal(),
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "limit_exceeded",
  );

  for (const [body, code] of [
    [{ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }, "restart_batch"],
    [{ added: [], modified: [], removed: [], next_cursor: "", has_more: false }, "not_ready"],
  ] as const) {
    const transport = mock([
      { body: { item: { item_id: "item-1" } } },
      { ...(code === "restart_batch" ? { status: 400 } : {}), body },
    ]);
    await assert.rejects(
      new PlaidProvider({ fetch: transport.fetch, plaidEnvironment: "sandbox" }).pull({
        credential: { accessToken: "token", clientId: "client", clientSecret: "secret" },
        cursor: "stable",
        continuation:
          code === "restart_batch"
            ? Buffer.from(JSON.stringify({ provider: "plaid", cursor: "page" })).toString(
                "base64url",
              )
            : undefined,
        window: { from: 1, to: 2 },
        limit: 10,
        signal: signal(),
      }),
      (error: unknown) => error instanceof ProviderError && error.code === code,
    );
  }
});

test("provider failures distinguish revocation, rate limits, cancellation, and expired cursors", async () => {
  for (const [status, code] of [
    [401, "revoked"],
    [429, "rate_limited"],
  ] as const) {
    const transport = mock([{ status, body: { error: "must not leak" } }]);
    await assert.rejects(
      new GoogleCalendarProvider({ fetch: transport.fetch }).identity(
        { accessToken: "never-in-error" },
        signal(),
      ),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === code &&
        !error.message.includes("never-in-error"),
    );
  }
  const expired = mock([
    { body: { id: "owner@example.test" } },
    { status: 410, body: { error: "gone" } },
  ]);
  await assert.rejects(
    new GoogleCalendarProvider({ fetch: expired.fetch }).pull({
      credential: { accessToken: "token" },
      cursor: "old",
      window: { from: 1, to: 2 },
      limit: 1,
      signal: signal(),
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "expired_cursor",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new GmailProvider({ fetch: mock([]).fetch }).identity(
      { accessToken: "token" },
      controller.signal,
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "cancelled",
  );

  const never = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;
  await assert.rejects(
    new GoogleCalendarProvider({ fetch: never, deadlineMs: 5 }).identity(
      { accessToken: "token" },
      signal(),
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "timeout",
  );
});
