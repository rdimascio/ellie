import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { defaults } from "@ellie/config";
import { Client } from "@ellie/transport";
import { record } from "@ellie/protocol";
import { Auth, newToken } from "../apps/server/src/auth.ts";
import { createEllieServer } from "../apps/server/src/index.ts";
import { generateCertificate } from "../apps/cli/src/certificate.ts";

export async function fixture(timeout = 2000) {
  const dir = await mkdtemp(join(tmpdir(), "ellie-e2e-"));
  const { key, cert } = await generateCertificate();
  const token = newToken();
  await Auth.initialize(token, dir);
  const auth = await Auth.open(dir);
  const app = createEllieServer({
    key,
    cert,
    auth,
    preferences: defaults,
    commandTimeout: timeout,
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const controller = new Client(origin, cert, token);
  const clients = [controller];
  async function pair(id: string) {
    const invite = record(await controller.call("POST", "/v1/invite", {}));
    const guest = new Client(origin, cert);
    clients.push(guest);
    const paired = record(await guest.call("POST", "/v1/pair", { id, code: invite.code }));
    const client = new Client(origin, cert, String(paired.token));
    clients.push(client);
    return client;
  }
  return {
    app,
    origin,
    cert,
    controller,
    pair,
    async close() {
      clients.forEach((client) => client.close());
      app.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
