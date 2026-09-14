import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./phone-remote.css";

interface Node {
  id: string;
  label: string;
  online: boolean;
  capabilities: "app.open"[];
}

type LoadState = "loading" | "ready" | "unconfigured" | "failed";
type CommandState =
  | { kind: "idle" }
  | { kind: "sending"; nodeId: string }
  | { kind: "success" | "failed" | "unknown"; message: string };

class RemoteFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Remote request failed.");
    this.status = status;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new RemoteFailure(0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024) throw new RemoteFailure(0);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function checkedNodes(body: unknown): Node[] {
  const value = (body as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(value) || value.length > 32) throw new RemoteFailure(0);
  const ids = new Set<string>();
  return value.map((candidate) => {
    const node = candidate as Partial<Node> | undefined;
    if (
      !node ||
      typeof node.id !== "string" ||
      node.id.length < 1 ||
      node.id.length > 100 ||
      ids.has(node.id) ||
      typeof node.label !== "string" ||
      [...node.label].length < 1 ||
      [...node.label].length > 64 ||
      /\p{C}/u.test(node.label) ||
      typeof node.online !== "boolean" ||
      !Array.isArray(node.capabilities) ||
      node.capabilities.length > 8 ||
      node.capabilities.some((capability) => capability !== "app.open")
    )
      throw new RemoteFailure(0);
    ids.add(node.id);
    return {
      id: node.id,
      label: node.label,
      online: node.online,
      capabilities: node.capabilities as "app.open"[],
    };
  });
}

function checkedResult(body: unknown): { ok: boolean; message: string } {
  const value = body as { ok?: unknown; message?: unknown } | undefined;
  if (
    !value ||
    typeof value.ok !== "boolean" ||
    typeof value.message !== "string" ||
    [...value.message].length > 160 ||
    /\p{C}/u.test(value.message)
  )
    throw new RemoteFailure(0);
  return { ok: value.ok, message: value.message };
}

const appCommands = ["Open Arc", "Open Safari", "Open Messages"] as const;

export function PhoneRemote() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [command, setCommand] = useState("");
  const [commandState, setCommandState] = useState<CommandState>({ kind: "idle" });
  const mounted = useRef(false);
  const loading = useRef(false);
  const posting = useRef(false);
  const requests = useRef(new Set<AbortController>());

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    setLoadState("loading");
    const abort = new AbortController();
    requests.current.add(abort);
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetch("/browser/v1/nodes", {
        signal: abort.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RemoteFailure(response.status);
      }
      const nextNodes = checkedNodes(await boundedJson(response));
      if (!mounted.current) return;
      setNodes(nextNodes);
      setSelectedId((current) =>
        nextNodes.some((node) => node.id === current) ? current : (nextNodes[0]?.id ?? ""),
      );
      setLoadState("ready");
    } catch (error) {
      if (!mounted.current) return;
      setNodes([]);
      setSelectedId("");
      setLoadState(
        error instanceof RemoteFailure && error.status === 503 ? "unconfigured" : "failed",
      );
    } finally {
      clearTimeout(timeout);
      requests.current.delete(abort);
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      for (const request of requests.current) request.abort();
    };
  }, [refresh]);

  const selected = nodes.find((node) => node.id === selectedId);
  const canSend =
    !!selected?.online &&
    selected.capabilities.includes("app.open") &&
    commandState.kind !== "sending";

  const send = async (text: string) => {
    const target = selected;
    const trimmed = text.trim();
    if (!target || !canSend || !trimmed || [...trimmed].length > 120 || posting.current) return;
    posting.current = true;
    setCommandState({ kind: "sending", nodeId: target.id });
    const abort = new AbortController();
    requests.current.add(abort);
    const timeout = setTimeout(() => abort.abort(), 40_000);
    let responseReceived = false;
    let outcomeUnknown = false;
    try {
      const response = await fetch("/browser/v1/commands", {
        method: "POST",
        signal: abort.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: target.id, text: trimmed }),
      });
      responseReceived = true;
      if (!response.ok) {
        await response.body?.cancel();
        outcomeUnknown = response.status === 502;
        throw new RemoteFailure(response.status);
      }
      const result = checkedResult(await boundedJson(response));
      if (!mounted.current) return;
      setCommandState({
        kind: result.ok ? "success" : "failed",
        message:
          result.message || (result.ok ? "Command completed." : "Command couldn’t be completed."),
      });
      if (result.ok) setCommand("");
    } catch {
      if (!mounted.current) return;
      setCommandState(
        outcomeUnknown || !responseReceived
          ? {
              kind: "unknown",
              message: `Outcome unknown. Check ${target.label} before sending it again.`,
            }
          : {
              kind: "failed",
              message: "Command couldn’t be completed. Review the command and try again.",
            },
      );
    } finally {
      clearTimeout(timeout);
      requests.current.delete(abort);
      posting.current = false;
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(command);
  };

  return (
    <section className="phone-remote" aria-labelledby="phone-remote-heading">
      <div className="phone-remote-heading">
        <div>
          <p className="phone-remote-kicker">Phone remote</p>
          <h2 id="phone-remote-heading">Control a Mac</h2>
        </div>
        <button
          className="remote-refresh"
          type="button"
          onClick={() => void refresh()}
          disabled={loadState === "loading" || commandState.kind === "sending"}
        >
          Refresh devices
        </button>
      </div>

      {loadState === "loading" ? (
        <p className="remote-note" role="status">
          Loading devices…
        </p>
      ) : loadState === "unconfigured" ? (
        <p className="remote-note" role="status">
          Phone controls aren’t configured on this Mac.
        </p>
      ) : loadState === "failed" ? (
        <p className="remote-note" role="status">
          Devices couldn’t be loaded. Check that Ellie is reachable, then refresh.
        </p>
      ) : nodes.length === 0 ? (
        <p className="remote-note" role="status">
          No Macs are available yet. Refresh after one connects.
        </p>
      ) : (
        <>
          <label htmlFor="remote-node">Send to</label>
          <select
            id="remote-node"
            value={selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setCommandState({ kind: "idle" });
            }}
            disabled={commandState.kind === "sending"}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label} · {node.online ? "Online" : "Offline"}
              </option>
            ))}
          </select>
          {selected && !selected.online && (
            <p className="remote-note">
              {selected.label} is offline. Choose an online Mac or refresh devices.
            </p>
          )}
          {selected && !selected.capabilities.includes("app.open") && (
            <p className="remote-note">App controls aren’t available on {selected.label}.</p>
          )}

          <div className="remote-apps" aria-label="Open an app">
            {appCommands.map((appCommand) => (
              <button
                key={appCommand}
                type="button"
                onClick={() => void send(appCommand)}
                disabled={!canSend}
              >
                <span aria-hidden="true">{appCommand === "Open Messages" ? "💬" : "↗"}</span>
                {appCommand}
              </button>
            ))}
          </div>

          <form className="remote-command" onSubmit={submit}>
            <label htmlFor="remote-command">Command</label>
            <div>
              <input
                id="remote-command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                maxLength={120}
                placeholder="Open Safari"
                autoComplete="off"
                disabled={!canSend}
              />
              <button type="submit" disabled={!canSend || !command.trim()}>
                Send
              </button>
            </div>
          </form>
          <p className="dictation-note">
            To speak a command, tap the microphone on your iPhone keyboard. Review the text, then
            tap Send.
          </p>
          <p className={`remote-result ${commandState.kind}`} role="status">
            {commandState.kind === "sending"
              ? `Sending to ${nodes.find((node) => node.id === commandState.nodeId)?.label ?? "selected Mac"}…`
              : commandState.kind === "idle"
                ? ""
                : commandState.message}
          </p>
        </>
      )}
    </section>
  );
}
