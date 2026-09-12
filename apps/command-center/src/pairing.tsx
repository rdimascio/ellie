import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ellieIcon from "../../../packages/macos/assets/Ellie.png";
import { QrScanner } from "./qr-scanner.tsx";
import "./tokens.css";
import "./pairing.css";

interface Client {
  id: string;
  label: string;
  role: "phone_controller" | "tv_viewer";
  expiresAt: number;
}
type Phase = "checking" | "unpaired" | "pairing" | "connected" | "disconnecting" | "unavailable";
interface Connection {
  phase: Phase;
  client?: Client;
  note?: string;
}
class RequestFailure extends Error {
  status: number;
  constructor(status: number) {
    super("Connection request failed.");
    this.status = status;
  }
}

function checkedClient(body: unknown): Client {
  const value = (body as { client?: Partial<Client> } | undefined)?.client;
  if (
    !value ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 100 ||
    typeof value.label !== "string" ||
    [...value.label].length < 1 ||
    [...value.label].length > 64 ||
    /\p{C}/u.test(value.label) ||
    !["phone_controller", "tv_viewer"].includes(value.role ?? "") ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) < 0 ||
    Number(value.expiresAt) > 8_640_000_000_000_000
  )
    throw new RequestFailure(0);
  return { id: value.id, label: value.label, role: value.role!, expiresAt: value.expiresAt! };
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new RequestFailure(0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024) throw new RequestFailure(0);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function useConnection() {
  const [connection, setConnection] = useState<Connection>({ phase: "checking" });
  const mounted = useRef(false);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const knownClient = useRef(false);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requests = useRef(new Set<AbortController>());
  const pendingRead = useRef<AbortController | undefined>(undefined);
  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const request = useCallback(async (method: "GET" | "POST", path: string, body?: unknown) => {
    const abort = new AbortController();
    if (method === "GET") {
      pendingRead.current?.abort();
      pendingRead.current = abort;
    }
    requests.current.add(abort);
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetch(`/browser/v1/${path}`, {
        method,
        signal: abort.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RequestFailure(response.status);
      }
      return await responseJson(response);
    } finally {
      clearTimeout(timeout);
      requests.current.delete(abort);
      if (pendingRead.current === abort) pendingRead.current = undefined;
    }
  }, []);

  const refresh = useCallback(
    async function checkConnection(notes?: {
      connected: string;
      unpaired: string;
      unavailable: string;
    }): Promise<void> {
      if (!mounted.current || mutating.current) return;
      clearTimer();
      const revision = ++sequence.current;
      try {
        const client = checkedClient(await request("GET", "session"));
        if (!mounted.current || sequence.current !== revision) return;
        knownClient.current = true;
        failures.current = 0;
        setConnection({ phase: "connected", client, note: notes?.connected });
        if (!document.hidden) timer.current = setTimeout(() => void checkConnection(), 10_000);
      } catch (error) {
        if (!mounted.current || sequence.current !== revision) return;
        if (error instanceof RequestFailure && error.status === 401) {
          setConnection({
            phase: "unpaired",
            note:
              notes?.unpaired ??
              (knownClient.current
                ? "Your connection has ended. Ask for a new pairing code."
                : undefined),
          });
          knownClient.current = false;
          failures.current = 0;
        } else {
          setConnection({
            phase: "unavailable",
            note:
              notes?.unavailable ??
              "Ellie is unavailable. Check that you’re on the same home network and the coordinating Mac is awake.",
          });
          failures.current = Math.min(failures.current + 1, 4);
          if (!document.hidden && navigator.onLine)
            timer.current = setTimeout(
              () => void checkConnection(notes),
              Math.min(30_000, 2000 * 2 ** (failures.current - 1)),
            );
        }
      }
    },
    [clearTimer, request],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const wake = () => {
      if (!document.hidden) void refresh();
      else clearTimer();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      clearTimer();
      for (const pending of requests.current) pending.abort();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [clearTimer, refresh]);

  const pair = async (code: string) => {
    if (mutating.current || !/^[a-f0-9]{64}$/.test(code)) return;
    clearTimer();
    sequence.current += 1;
    mutating.current = true;
    setConnection({ phase: "pairing" });
    try {
      const client = checkedClient(await request("POST", "pair", { code }));
      if (!mounted.current) return;
      knownClient.current = true;
      setConnection({ phase: "connected", client });
      timer.current = setTimeout(() => void refresh(), 10_000);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof RequestFailure && error.status === 400)
        setConnection({
          phase: "unpaired",
          note: "That code couldn’t be used. Ask for a fresh pairing code and try again.",
        });
      else {
        mutating.current = false;
        await refresh({
          connected: "Connection confirmed.",
          unpaired: "Pairing wasn’t confirmed. Ask for a fresh pairing code before trying again.",
          unavailable: "Pairing wasn’t confirmed. Check your connection before trying again.",
        });
      }
    } finally {
      mutating.current = false;
    }
  };

  const disconnect = async () => {
    if (mutating.current) return;
    clearTimer();
    sequence.current += 1;
    mutating.current = true;
    setConnection({ phase: "disconnecting" });
    try {
      const result = await request("POST", "logout", {});
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        Object.keys(result).length !== 1 ||
        (result as { ok?: unknown }).ok !== true
      )
        throw new RequestFailure(0);
      if (!mounted.current) return;
      knownClient.current = false;
      setConnection({ phase: "unpaired", note: "This device is disconnected." });
    } catch {
      if (!mounted.current) return;
      mutating.current = false;
      await refresh({
        connected:
          "This device is still connected. Try disconnecting again, or revoke it from the coordinating Mac.",
        unpaired: "This device is disconnected.",
        unavailable:
          "Disconnection wasn’t confirmed. Try again when Ellie is reachable, or revoke this device from the coordinating Mac.",
      });
    } finally {
      mutating.current = false;
    }
  };
  return { connection, pair, disconnect, refresh };
}

function Pairing() {
  const { connection, pair, disconnect, refresh } = useConnection();
  const [code, setCode] = useState("");
  const [visible, setVisible] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | undefined>();
  const scanButton = useRef<HTMLButtonElement>(null);
  const { phase, client } = connection;
  useEffect(() => {
    if (phase !== "unpaired") {
      setScanning(false);
      setScanNote(undefined);
    }
  }, [phase]);
  const connected = phase === "connected" && client;
  const waiting = phase === "checking" || phase === "pairing" || phase === "disconnecting";
  const heading = connected
    ? "Connected to Ellie"
    : phase === "unavailable"
      ? "Let’s reconnect"
      : "Connect this device";
  const status =
    phase === "checking"
      ? "Checking your connection…"
      : phase === "pairing"
        ? "Connecting this device…"
        : phase === "disconnecting"
          ? "Disconnecting this device…"
          : ((phase === "unpaired" ? scanNote : undefined) ??
            connection.note ??
            (connected ? "Connection confirmed." : undefined));
  return (
    <div className={`pairing-page ${client?.role === "tv_viewer" ? "shared-display" : ""}`}>
      <a className="pairing-skip" href="#pairing-main">
        Skip to content
      </a>
      <header className="pairing-brand">
        <img src={ellieIcon} alt="" width="42" height="42" />
        <span>ellie</span>
      </header>
      <main id="pairing-main" className="pairing-panel" aria-busy={waiting}>
        <div className={`connection-symbol ${connected ? "confirmed" : ""}`} aria-hidden="true">
          {connected ? "✓" : "e"}
        </div>
        <h1>{heading}</h1>
        {connected ? (
          <>
            <p className="pairing-intro">A place for this device in your home.</p>
            <dl className="connection-details">
              <div>
                <dt>Device</dt>
                <dd>{client.label}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>
                  {client.role === "phone_controller"
                    ? "Phone remote"
                    : "Shared display · read only"}
                </dd>
              </div>
              <div>
                <dt>Connected until</dt>
                <dd>
                  <time dateTime={new Date(client.expiresAt).toISOString()}>
                    {new Date(client.expiresAt).toLocaleDateString(undefined, {
                      dateStyle: "medium",
                    })}
                  </time>
                </dd>
              </div>
            </dl>
            <p className="version-note">
              Connection is ready. Household controls aren’t available in this version.
            </p>
            <button className="pairing-button secondary" onClick={() => void disconnect()}>
              Disconnect this device
            </button>
          </>
        ) : phase === "unpaired" ? (
          <>
            <p className="pairing-intro">
              Scan the QR code shown by Ellie on your Mac, or enter a pairing code.
            </p>
            {scanning ? (
              <QrScanner
                onCode={(decoded) => {
                  setScanning(false);
                  setCode("");
                  setVisible(false);
                  setScanNote(undefined);
                  void pair(decoded);
                }}
                onCancel={(note) => {
                  setScanning(false);
                  setScanNote(note);
                  requestAnimationFrame(() => scanButton.current?.focus());
                }}
              />
            ) : (
              <>
                <button
                  ref={scanButton}
                  className="pairing-button scan-button"
                  type="button"
                  onClick={() => {
                    setCode("");
                    setVisible(false);
                    setScanNote(undefined);
                    setScanning(true);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
                    <path
                      d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path d="M7 7h3v3H7zm7 0h3v3h-3zm-7 7h3v3H7zm7 0h3v3h-3z" fill="currentColor" />
                  </svg>
                  Scan QR code
                </button>
                <p className="pairing-alternative">or enter a code</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const submitted = code.trim();
                    setCode("");
                    setVisible(false);
                    setScanNote(undefined);
                    void pair(submitted);
                  }}
                >
                  <label htmlFor="pairing-code">Pairing code</label>
                  <div className="code-input">
                    <input
                      id="pairing-code"
                      name="pairing-code"
                      type={visible ? "text" : "password"}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      maxLength={64}
                      pattern="[a-f0-9]{64}"
                      required
                      aria-describedby="code-help"
                    />
                    <button
                      type="button"
                      aria-label={visible ? "Hide pairing code" : "Show pairing code"}
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? "Hide" : "Show"}
                    </button>
                  </div>
                  <p id="code-help" className="code-help">
                    Codes work once and expire after 10 minutes.
                  </p>
                  <button
                    className="pairing-button secondary"
                    type="submit"
                    disabled={!/^[a-f0-9]{64}$/.test(code.trim())}
                  >
                    Connect to Ellie
                  </button>
                </form>
              </>
            )}
          </>
        ) : phase === "unavailable" ? (
          <button className="pairing-button" onClick={() => void refresh()}>
            Check connection
          </button>
        ) : (
          <div className="connection-progress" aria-hidden="true" />
        )}
        <p className={`pairing-status ${connection.note ? "has-note" : ""}`} role="status">
          {status}
        </p>
      </main>
      <footer className="pairing-footer">
        At home, with Ellie.
        <br />
        <span>Your connection stays on your home network.</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Pairing />);
