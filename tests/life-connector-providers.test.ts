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

test("Google Calendar lists bounded choices and pulls only the selected calendar", async () => {
  const transport = mock([
    {
      body: {
        items: [
          { id: "primary@example.test", summary: "Primary", primary: true },
          { id: "other@example.test", summary: "Other", primary: false },
        ],
      },
    },
    { body: { id: "primary@example.test", summary: "Primary" } },
    { body: { items: [], nextSyncToken: "other-cursor" } },
  ]);
  const provider = new GoogleCalendarProvider({ fetch: transport.fetch });
  const calendars = await provider.calendars({ accessToken: "secret" }, signal());
  assert.deepEqual(
    calendars.map((item) => item.id),
    ["primary@example.test", "other@example.test"],
  );
  assert.equal(new URL(transport.requests[0]!.url).pathname, "/calendar/v3/users/me/calendarList");
  const result = await provider.pull({
    credential: { accessToken: "secret" },
    resourceId: "other@example.test",
    window: { from: 1_700_000_000_000, to: 1_800_000_000_000 },
    limit: 50,
    signal: signal(),
  });
  assert.equal(result.cursor, "other-cursor");
  assert.equal(
    new URL(transport.requests[2]!.url).pathname,
    "/calendar/v3/calendars/other%40example.test/events",
  );
  assert.equal(JSON.stringify(calendars).includes("secret"), false);
});

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

test("explicit Gmail full read returns only bounded inline plain text", async () => {
  const plain = "Hello from a private fixture.\nNo HTML is rendered.";
  const transport = mock([
    {
      body: {
        id: "message_1",
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from(plain).toString("base64url") } },
            {
              mimeType: "text/html",
              body: { data: Buffer.from("<img src='remote'>").toString("base64url") },
            },
          ],
        },
      },
    },
  ]);
  const result = await new GmailProvider({ fetch: transport.fetch }).readMessageText(
    "message_1",
    { accessToken: "private-token" },
    signal(),
  );
  assert.deepEqual(result, { status: "plain", text: plain });
  const request = new URL(transport.requests[0]!.url);
  assert.equal(request.origin, "https://gmail.googleapis.com");
  assert.equal(request.searchParams.get("format"), "full");
  assert.equal(request.pathname, "/gmail/v1/users/me/messages/message_1");
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  assert.equal(transport.requests.length, 1, "no attachment or image request follows");

  const multiple = mock([
    {
      body: {
        id: "multipart_1",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("First part").toString("base64url") },
            },
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("Second part").toString("base64url") },
            },
          ],
        },
      },
    },
  ]);
  assert.deepEqual(
    await new GmailProvider({ fetch: multiple.fetch }).readMessageText(
      "multipart_1",
      { accessToken: "private-token" },
      signal(),
    ),
    { status: "plain", text: "First part", additionalPartsOmitted: true },
  );
  assert.equal(multiple.requests.length, 1);

  const long = mock([
    {
      body: {
        id: "long_1",
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("x".repeat(32 * 1_024 + 7)).toString("base64url"),
          },
        },
      },
    },
  ]);
  const truncated = await new GmailProvider({ fetch: long.fetch }).readMessageText(
    "long_1",
    { accessToken: "private-token" },
    signal(),
  );
  assert.equal(truncated.status, "truncated");
  assert.equal(Buffer.byteLength(truncated.text ?? ""), 32 * 1_024);
});

test("Gmail full read reports HTML-only and rejects malformed or oversized MIME", async () => {
  const htmlOnly = mock([
    {
      body: {
        id: "html_1",
        payload: {
          mimeType: "text/html",
          body: {
            data: Buffer.from("<script>not plain text</script>").toString("base64url"),
          },
        },
      },
    },
  ]);
  assert.deepEqual(
    await new GmailProvider({ fetch: htmlOnly.fetch }).readMessageText(
      "html_1",
      { accessToken: "token" },
      signal(),
    ),
    { status: "unavailable" },
  );
  const attached = mock([
    {
      body: {
        id: "attached_1",
        payload: {
          mimeType: "text/plain",
          filename: "secret.txt",
          body: { attachmentId: "remote-attachment" },
        },
      },
    },
  ]);
  assert.deepEqual(
    await new GmailProvider({ fetch: attached.fetch }).readMessageText(
      "attached_1",
      { accessToken: "token" },
      signal(),
    ),
    { status: "unavailable" },
  );
  assert.equal(attached.requests.length, 1);
  const invalid = mock([
    {
      body: {
        id: "bad_1",
        payload: { mimeType: "text/plain", body: { data: "not+base64url" } },
      },
    },
  ]);
  await assert.rejects(
    new GmailProvider({ fetch: invalid.fetch }).readMessageText(
      "bad_1",
      { accessToken: "token" },
      signal(),
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_response",
  );
  const oversized = mock([
    {
      body: {
        id: "deep_1",
        payload: {
          mimeType: "multipart/mixed",
          parts: Array.from({ length: 65 }, () => ({ mimeType: "text/html" })),
        },
      },
    },
  ]);
  await assert.rejects(
    new GmailProvider({ fetch: oversized.fetch }).readMessageText(
      "deep_1",
      { accessToken: "token" },
      signal(),
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "limit_exceeded",
  );
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
