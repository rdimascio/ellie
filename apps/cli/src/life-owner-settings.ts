import { record } from "@ellie/protocol";

interface Client {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}

export async function openLifeOwnerSettings(client: Client): Promise<string> {
  const result = record(await client.call("POST", "/v1/life/owner-settings", {}));
  if (Object.keys(result).length !== 1 || result.opened !== true)
    throw new Error("Life owner settings did not open.");
  return "Ellie account settings opened.";
}
