import { HouseholdState } from "../apps/server/src/household-state.ts";

const path = "/native/v1/household/shared/chores";
const prefix = "/__ellie-test/chores/";

/** Fixture faults wrap the production handler; authority and documents remain production state. */
export async function createIOSHouseholdChoresFixture({ directory, nativeAuth, clients, tokens }) {
  const household = await HouseholdState.openOrInitialize(directory);
  for (const client of Object.values(clients)) {
    if (
      !(await household.grant(nativeAuth, {
        clientId: client.id,
        profile: "shared",
        kind: "chores",
        access: "write",
      }))
    )
      throw new Error("Synthetic chore grant failed.");
  }
  const counts = { reads: 0, writes: 0, dropped: 0, held: 0, releaseAttempts: 0, controls: 0 };
  let dropNextWrite = false;
  let holdNextRead = false;
  let heldRead;
  const bearerA = `Bearer ${tokens.a}`;
  const bearerB = `Bearer ${tokens.b}`;

  function wrapProduction(request, response) {
    if (request.url !== path) return;
    if (request.method === "PUT") {
      counts.writes++;
      if (!dropNextWrite) return;
      dropNextWrite = false;
      const end = response.end.bind(response);
      response.end = (...args) => {
        if (response.statusCode === 200) {
          counts.dropped++;
          response.destroy();
          return response;
        }
        return end(...args);
      };
    } else if (request.method === "GET") {
      counts.reads++;
      if (!holdNextRead || request.headers.authorization !== bearerB) return;
      holdNextRead = false;
      const end = response.end.bind(response);
      response.end = (...args) => {
        if (response.statusCode === 200) {
          counts.held++;
          heldRead = () => {
            counts.releaseAttempts++;
            if (!response.destroyed) end(...args);
          };
          return response;
        }
        return end(...args);
      };
    }
  }

  function handleControl(request, response) {
    if (!request.url?.startsWith(prefix)) return false;
    void (async () => {
      const command = request.url.slice(prefix.length);
      const authorized =
        request.method === "GET" &&
        request.headers["x-ellie-version"] === "1" &&
        request.headers.authorization === (command === "revoke-b" ? bearerB : bearerA);
      let ok = authorized;
      if (ok) {
        counts.controls++;
        if (command === "arm-drop") dropNextWrite = true;
        else if (command === "arm-hold") holdNextRead = true;
        else if (command === "held") {
          const deadline = Date.now() + 5_000;
          while (!heldRead && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 20));
          ok = heldRead !== undefined;
        } else if (command === "revoke-b")
          ok = await household.revoke({
            clientId: clients.b.id,
            profile: "shared",
            kind: "chores",
          });
        else if (command === "release") {
          ok = heldRead !== undefined;
          const release = heldRead;
          heldRead = undefined;
          release?.();
        } else ok = false;
      }
      response.writeHead(ok ? 200 : 409, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok }));
    })().catch(() => response.destroy());
    return true;
  }

  return { household, counts, wrapProduction, handleControl, close: () => household.close() };
}
