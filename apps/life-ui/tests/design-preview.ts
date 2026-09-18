import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { Bootstrap, LifeRecord } from "../src/types.ts";

const fixtureScope = { type: "user" as const, id: "design-fixture" };
const record = (
  id: string,
  title: string,
  kind: LifeRecord["kind"],
  data: Record<string, unknown>,
  body?: string,
): LifeRecord => ({
  id,
  title,
  kind,
  data,
  body,
  scope: fixtureScope,
  revision: 1,
  createdAt: "2026-09-16T08:00:00Z",
  updatedAt: "2026-09-16T08:00:00Z",
});
export const designBootstrap: Bootstrap = {
  profile: { id: "design-fixture", name: "Alex", timeZone: "America/Los_Angeles" },
  groups: [],
  scope: "user:design-fixture",
  chatEpoch: 1,
  records: [
    record(
      "design-walk",
      "A little time outside",
      "event",
      { startAt: "2026-09-16T23:30:00Z" },
      "A walk by the water.",
    ),
    record(
      "design-dinner",
      "Dinner with friends",
      "event",
      { startAt: "2026-09-17T02:00:00Z" },
      "Bring something to share.",
    ),
    record(
      "design-memory",
      "A slower start",
      "memory",
      {},
      "Keep the first hour of the morning free when possible.",
    ),
  ],
  tasks: [
    {
      id: "design-task",
      title: "Weekend itinerary",
      status: "succeeded",
      detail: "A saved plan for a change of scenery.",
      actions: [],
    },
  ],
  plugins: [],
  settings: {},
  notifications: [],
  capabilities: {},
};
export const designConnections = {
  connections: [
    {
      id: "design-gmail",
      provider: "gmail",
      label: "Personal Gmail",
      state: "connected",
      mode: "observe",
      lastSyncAt: Date.parse("2026-09-16T22:38:00Z"),
    },
    {
      id: "design-plaid",
      provider: "plaid",
      label: "Everyday account",
      state: "connected",
      mode: "observe",
      lastSyncAt: Date.parse("2026-09-16T22:35:00Z"),
    },
  ],
  providers: [
    { id: "gmail", label: "Gmail", configured: true },
    { id: "google-calendar", label: "Google Calendar", configured: true },
    {
      id: "plaid",
      label: "Plaid",
      configured: false,
      setupMessage:
        "Bank linking isn’t available yet. Previously provisioned accounts can sync transactions.",
    },
  ],
};
designBootstrap.records.push({
  ...record(
    "design-finance-insight",
    "Your streaming charges follow a monthly rhythm.",
    "memory",
    {
      type: "connected-insight-v1",
      confidence: 0.9,
      connected: { connectionId: "design-plaid", expiresAt: Date.parse("2027-01-01T00:00:00Z") },
    },
    "Inferred from repeated settled charges in this sample account. A recurring pattern does not confirm an active subscription. Check the account before making changes.",
  ),
});

export const designPlans = {
  plans: [
    {
      record: record("design-plan", "A weekend away", "goal", {}),
      steps: [
        { id: "design-step-1", title: "Choose a place", completed: true },
        { id: "design-step-2", title: "Plan the route", completed: false },
        { id: "design-step-3", title: "Pack a bag", completed: false },
      ],
      completedSteps: 1,
      totalSteps: 3,
      completed: false,
    },
  ],
  hasMore: false,
  unavailableCount: 0,
};

// A loopback-only visual fixture. It cannot reach a coordinator or execute actions.
export async function startDesignPreview(port = 0) {
  const dist = resolve("apps/life-ui/dist");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (pathname === "/review") {
      response.setHeader("Content-Type", "text/html");
      createReadStream(new URL("./fixtures/mobile-design-review.html", import.meta.url)).pipe(
        response,
      );
      return;
    }
    if (pathname.startsWith("/api/")) {
      response.setHeader("Content-Type", "application/json");
      if (request.method !== "GET") {
        response.writeHead(409).end(
          JSON.stringify({
            message:
              "This design preview uses sample data. Open your connected Ellie app to send requests or save changes.",
          }),
        );
        return;
      }
      const values: Record<string, unknown> = {
        "/api/life/bootstrap": designBootstrap,
        "/api/connections": designConnections,
        "/api/life/plans": designPlans,
        "/api/life/memory": {
          summary: "You like unhurried mornings and getting outside.",
          entries: 2,
        },
        "/api/life/model/status": { mode: "deterministic", available: true },
        "/api/life/conversations": { conversations: [], hasMore: false },
      };
      const value =
        values[pathname] ??
        (pathname.startsWith("/api/life/records/")
          ? designBootstrap.records.find((item) => item.id === pathname.split("/").at(-1))
          : undefined);
      if (value === undefined) {
        response
          .writeHead(404)
          .end(JSON.stringify({ message: "This screen is not connected in the design preview." }));
        return;
      }
      response.end(JSON.stringify(value));
      return;
    }
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(dist + sep)) {
      response.writeHead(404).end();
      return;
    }
    const contentTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
    };
    response.setHeader("Content-Type", contentTypes[extname(file)] ?? "application/octet-stream");
    createReadStream(file)
      .on("error", () => {
        response.writeHead(404).end();
      })
      .pipe(response);
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview did not bind a port.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

if (import.meta.main) {
  const { origin } = await startDesignPreview(4187);
  console.log(`Ellie design preview (sample data; actions disabled): ${origin}/review`);
}
