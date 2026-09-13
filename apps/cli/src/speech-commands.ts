import { identifier, record } from "@ellie/protocol";
import { SPEECH_CAPABILITY } from "../../server/src/native-speech.ts";
interface Client {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}
export type SpeechCommand = { action: "list" } | { action: "grant" | "revoke"; clientId: string };
const usage = "Use: bun run ellie speech grants | grant CLIENT | revoke CLIENT";
export function parseSpeechCommand(args: string[]): SpeechCommand {
  try {
    if (args.length === 1 && args[0] === "grants") return { action: "list" };
    if (args.length === 2 && (args[0] === "grant" || args[0] === "revoke"))
      return { action: args[0], clientId: identifier(args[1]) };
  } catch {}
  throw new Error(usage);
}
export async function runSpeechCommand(client: Client, command: SpeechCommand): Promise<string> {
  if (command.action === "list") {
    const body = record(await client.call("GET", "/v1/speech/authorities"));
    if (Object.keys(body).length !== 1 || !Array.isArray(body.grants))
      throw new Error("Invalid speech authority list.");
    return JSON.stringify(body.grants, null, 2);
  }
  const body = record(
    await client.call(
      "POST",
      command.action === "grant" ? "/v1/speech/authorities" : "/v1/speech/authorities/revoke",
      command.action === "grant"
        ? { clientId: command.clientId, capability: SPEECH_CAPABILITY }
        : { clientId: command.clientId },
    ),
  );
  if (body.ok !== true) throw new Error("Speech authority was not confirmed.");
  if (command.action === "grant") {
    if (
      Object.keys(body).length !== 2 ||
      JSON.stringify(body.grant) !==
        JSON.stringify({ clientId: command.clientId, capability: SPEECH_CAPABILITY })
    )
      throw new Error("Speech authority was not confirmed.");
    return "Native speech grant saved.";
  }
  if (Object.keys(body).length !== 2 || typeof body.revoked !== "boolean")
    throw new Error("Speech revocation was not confirmed.");
  return body.revoked ? "Native speech grant revoked." : "Native speech grant was not active.";
}
