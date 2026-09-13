import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const APPS = { arc: "Arc", safari: "Safari", messages: "Messages" } as const;
export interface PhoneSmokeConfig {
  driverOrigin: string;
  origin: string;
  deviceId: string;
  invitationFile: string;
  nodeId?: string;
  app?: keyof typeof APPS;
}

export function phoneSmokeConfig(input: unknown): PhoneSmokeConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid test configuration.");
  const value = input as Record<string, unknown>;
  const allowed = ["driverOrigin", "origin", "deviceId", "invitationFile", "nodeId", "app"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unknown test setting.");
  for (const key of allowed.slice(0, 4))
    if (typeof value[key] !== "string") throw new Error("Missing test setting.");
  const driver = new URL(value.driverOrigin as string);
  const origin = new URL(value.origin as string);
  if (driver.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(driver.hostname))
    throw new Error("WebDriver must use literal loopback.");
  if (origin.protocol !== "https:") throw new Error("Phone origin must use trusted HTTPS.");
  for (const url of [driver, origin])
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Use bare origins.");
  if (
    !/^[A-Za-z0-9-]{1,128}$/.test(value.deviceId as string) ||
    !isAbsolute(value.invitationFile as string)
  )
    throw new Error("Invalid device or invitation path.");
  if ((value.app === undefined) !== (value.nodeId === undefined))
    throw new Error("An app test needs an explicit app and node.");
  if (
    value.app !== undefined &&
    (typeof value.app !== "string" ||
      !Object.hasOwn(APPS, value.app) ||
      typeof value.nodeId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(value.nodeId))
  )
    throw new Error("Invalid app test target.");
  return {
    driverOrigin: driver.origin,
    origin: origin.origin,
    deviceId: value.deviceId as string,
    invitationFile: value.invitationFile as string,
    ...(value.app === undefined
      ? {}
      : { app: value.app as keyof typeof APPS, nodeId: value.nodeId as string }),
  };
}

export async function readPrivateTestJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16_384 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Test files must be private regular files (0600).");
    const bytes = Buffer.alloc(16_385);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 16_384) throw new Error("Test file too large.");
    return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

export interface PhoneSmokeReport {
  passed: boolean;
  platform: "physical-ios";
  pairAttempted: boolean;
  paired: boolean;
  refreshed: boolean;
  command: "not-requested" | "not-sent" | "confirmed" | "unknown";
  loggedOut: boolean;
  sessionClosed: boolean;
  stage: string;
}

/** Drives real Safari UI. Inject fetch only for fake-driver regression tests. */
export async function runPhoneSmoke(
  config: PhoneSmokeConfig,
  invitation: unknown,
  transport: typeof fetch = fetch,
): Promise<PhoneSmokeReport> {
  phoneSmokeConfig(config);
  const invite = invitation as { code?: unknown; expiresAt?: unknown } | null;
  if (
    !invite ||
    typeof invite.code !== "string" ||
    !/^[a-f0-9]{64}$/.test(invite.code) ||
    typeof invite.expiresAt !== "number" ||
    !Number.isFinite(invite.expiresAt) ||
    invite.expiresAt <= Date.now() ||
    invite.expiresAt > Date.now() + 600_000
  )
    throw new Error("A fresh one-use invitation is required.");
  const report: PhoneSmokeReport = {
    passed: false,
    platform: "physical-ios",
    pairAttempted: false,
    paired: false,
    refreshed: false,
    command: config.app ? "not-sent" : "not-requested",
    loggedOut: false,
    sessionClosed: false,
    stage: "session",
  };
  let session = "";
  const deadline = Date.now() + 90_000;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    cleanup = false,
  ): Promise<Record<string, unknown>> {
    const remaining = cleanup ? 5000 : Math.min(45_000, deadline - Date.now());
    if (remaining <= 0) throw new Error("Test deadline reached.");
    const response = await transport(`${config.driverOrigin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(remaining),
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.body) throw new Error("Driver response unavailable.");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 65_536) throw new Error("Driver response too large.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      value?: Record<string, unknown>;
    };
    if (!response.ok || parsed.value?.error) throw new Error("WebDriver step failed.");
    return parsed as Record<string, unknown>;
  }
  const route = (suffix: string) => `/session/${encodeURIComponent(session)}${suffix}`;
  async function element(using: "css selector" | "xpath", value: string): Promise<string> {
    const response = await call("POST", route("/element"), { using, value });
    const id = (response.value as Record<string, unknown> | null)?.[ELEMENT];
    if (typeof id !== "string" || !id || id.length > 256)
      throw new Error("Test element unavailable.");
    return encodeURIComponent(id);
  }
  async function click(using: "css selector" | "xpath", value: string): Promise<void> {
    await call("POST", route(`/element/${await element(using, value)}/click`), {});
  }
  async function checkOrigin(): Promise<void> {
    const current = await call("GET", route("/url"));
    if (typeof current.value !== "string" || new URL(current.value).origin !== config.origin)
      throw new Error("Browser left the trusted origin.");
  }
  try {
    const created = await call("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "Safari",
          platformName: "iOS",
          "safari:deviceUDID": config.deviceId,
          "safari:useSimulator": false,
          acceptInsecureCerts: false,
        },
      },
    });
    const value = created.value as {
      sessionId?: unknown;
      capabilities?: {
        platformName?: unknown;
        acceptInsecureCerts?: unknown;
        "safari:useSimulator"?: unknown;
        "safari:deviceUDID"?: unknown;
      };
    } | null;
    if (typeof value?.sessionId !== "string" || value.sessionId.length > 256 || !value.sessionId)
      throw new Error("No test session.");
    session = value.sessionId;
    if (String(value.capabilities?.platformName).toLowerCase() !== "ios")
      throw new Error("Driver did not select iOS.");
    if (
      value.capabilities?.acceptInsecureCerts === true ||
      value.capabilities?.["safari:useSimulator"] === true ||
      (value.capabilities?.["safari:deviceUDID"] !== undefined &&
        value.capabilities["safari:deviceUDID"] !== config.deviceId)
    )
      throw new Error("Driver target or TLS policy mismatch.");
    await call("POST", route("/timeouts"), { implicit: 10_000, pageLoad: 15_000, script: 5000 });
    report.stage = "trusted-page";
    await call("POST", route("/url"), { url: config.origin });
    await checkOrigin();
    report.stage = "pair";
    await call("POST", route(`/element/${await element("css selector", "#pairing-code")}/value`), {
      text: invite.code,
    });
    report.pairAttempted = true;
    await click("css selector", "form button[type=submit]");
    await element("css selector", "#phone-remote-heading");
    report.paired = true;
    report.stage = "refresh";
    await call("POST", route("/refresh"), {});
    await element("css selector", "#phone-remote-heading");
    await checkOrigin();
    report.refreshed = true;
    if (config.app && config.nodeId) {
      report.stage = "command";
      await click("css selector", `#remote-node option[value="${config.nodeId}"]`);
      report.command = "unknown";
      await click(
        "xpath",
        `//div[@class='remote-apps']/button[contains(., 'Open ${APPS[config.app]}')]`,
      );
      await call("POST", route("/timeouts"), { implicit: 40_000, pageLoad: 15_000, script: 5000 });
      // Wait by finding success; command submission is never retried.
      const success = await element("css selector", ".remote-result.success");
      const outcome = await call("GET", route(`/element/${success}/text`));
      if (outcome.value !== `Opened ${APPS[config.app]}.`)
        throw new Error("Command outcome unavailable.");
      report.command = "confirmed";
    }
    report.stage = "logout";
    await click("xpath", "//button[normalize-space(.)='Disconnect this device']");
    await element("css selector", "#pairing-code");
    report.loggedOut = true;
    report.passed = true;
    report.stage = "complete";
  } catch {
    /* Deliberately omit driver errors: they may include cookies or page content. */
  } finally {
    if (session) {
      try {
        await call("DELETE", route(""), undefined, true);
        report.sessionClosed = true;
      } catch {
        report.passed = false;
        report.stage = "session-cleanup";
      }
    }
  }
  return report;
}
