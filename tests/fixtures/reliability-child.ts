import { appendFile, readFile } from "node:fs/promises";
import { defaults } from "@ellie/config";
import { CAPABILITIES } from "@ellie/protocol";
import type { Action } from "@ellie/protocol";
import { Client } from "@ellie/transport";
import { Auth } from "../../apps/server/src/auth.ts";
import { createEllieServer } from "../../apps/server/src/index.ts";
import { JobStore } from "../../apps/server/src/jobs.ts";
import { runNode } from "../../apps/node/src/index.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing synthetic fixture setting ${name}.`);
  return value;
};
const notify = (message: Record<string, unknown>) => process.send?.(message);

if (process.argv[2] === "stalled") {
  process.once("SIGTERM", () => notify({ event: "term" }));
  notify({ event: "ready" });
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "coordinator") {
  const directory = required("ELLIE_RELIABILITY_STATE");
  const auth = await Auth.open(directory);
  const jobs = new JobStore(`${directory}/jobs.sqlite`);
  const app = createEllieServer({
    key: await readFile(`${directory}/server-key.pem`, "utf8"),
    cert: await readFile(`${directory}/server-cert.pem`, "utf8"),
    auth,
    preferences: defaults,
    jobStore: jobs,
    commandTimeout: 15_000,
  });
  app.server.listen(Number(required("ELLIE_RELIABILITY_PORT")), "127.0.0.1", () =>
    notify({ event: "ready" }),
  );
  const close = () => {
    app.shutdown();
    process.exit(0);
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} else if (process.argv[2] === "node") {
  const stop = new AbortController();
  const client = new Client(
    required("ELLIE_RELIABILITY_ORIGIN"),
    await readFile(required("ELLIE_RELIABILITY_CERT"), "utf8"),
    required("ELLIE_RELIABILITY_NODE_TOKEN"),
  );
  const effects = required("ELLIE_RELIABILITY_EFFECTS");
  const executor = {
    capabilities: async () => [...CAPABILITIES],
    execute: async (action: Action, signal?: AbortSignal) => {
      await appendFile(effects, `${JSON.stringify(action)}\n`, { encoding: "utf8", mode: 0o600 });
      notify({ event: "effect", tool: action.tool });
      if (action.tool === "app.open" && action.app === "company.thebrowser.Browser")
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      return { ok: !signal?.aborted, message: signal?.aborted ? "Outcome unknown." : "Done." };
    },
  };
  const done = runNode({
    client,
    executor,
    preferences: defaults,
    signal: stop.signal,
    heartbeatMs: 25,
    reconnect: { baseMs: 10, maxMs: 50, random: () => 0.5 },
    onEvent: (event) => notify({ event }),
  });
  const close = () => stop.abort();
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  await done;
  client.close();
  process.exit(0);
} else {
  throw new Error("Unknown reliability fixture role.");
}
