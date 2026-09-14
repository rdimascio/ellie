import type { IncomingMessage } from "node:http";
import { identifier, record } from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import type { BrowserControl } from "./browser-management.ts";
import { NativeSpeechError, SPEECH_CAPABILITY } from "./native-speech.ts";

const routes = new Set(["/v1/speech/authorities", "/v1/speech/authorities/revoke"]);
const header = (request: IncomingMessage, name: string): string[] => {
  const result: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === name)
      result.push(request.rawHeaders[index + 1] ?? "");
  return result;
};
export async function handleSpeechManagement(
  request: IncomingMessage,
  path: string,
  role: "controller" | "node",
  control?: BrowserControl,
): Promise<{ status: number; body: unknown } | undefined> {
  if (!routes.has(path)) return undefined;
  if (role !== "controller")
    return { status: 403, body: { error: "Controller identity required." } };
  let current;
  try {
    current = control?.current();
  } catch {
    current = undefined;
  }
  if (current?.status !== "ready" || !current.speech)
    return { status: 503, body: { error: "Native speech unavailable." } };
  if (request.method === "GET" && path === "/v1/speech/authorities") {
    try {
      return { status: 200, body: { grants: current.speech.list() } };
    } catch {
      return { status: 503, body: { error: "Native speech unavailable." } };
    }
  }
  if (request.method !== "POST") return { status: 404, body: { error: "Speech route not found." } };
  const types = header(request, "content-type");
  if (types.length !== 1 || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(types[0]!))
    return { status: 415, body: { error: "JSON required." } };
  try {
    const body = record(await readJson(request, 4096));
    if (path === "/v1/speech/authorities") {
      if (Object.keys(body).length !== 2 || body.capability !== SPEECH_CAPABILITY)
        throw new NativeSpeechError("invalid");
      const value = { clientId: identifier(body.clientId), capability: SPEECH_CAPABILITY };
      return (await current.speech.grant(value))
        ? { status: 200, body: { ok: true, grant: value } }
        : { status: 404, body: { error: "Native client not found." } };
    }
    if (Object.keys(body).length !== 1) throw new NativeSpeechError("invalid");
    return {
      status: 200,
      body: { ok: true, revoked: await current.speech.revoke(identifier(body.clientId)) },
    };
  } catch (error) {
    return error instanceof NativeSpeechError && error.kind === "unavailable"
      ? { status: 503, body: { error: "Native speech unavailable." } }
      : { status: 400, body: { error: "Speech authority request rejected." } };
  }
}
