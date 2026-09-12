import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ensureState, nodeConfig, serverConfig } from "@ellie/config";
import {
  applicationExecutable,
  applicationId,
  MacOSServiceApplication,
} from "./service-application.ts";
import type { ServiceApplication } from "./service-application.ts";

export type ServiceRole = "coordinator" | "node";
export function serviceRole(value: unknown): ServiceRole {
  if (value !== "coordinator" && value !== "node")
    throw new Error("Choose a service: coordinator or node.");
  return value;
}
export type CommandResult = { code: number; stdout: string };
export type Run = (file: string, args: string[]) => Promise<CommandResult>;
// Never return child stderr: launchctl and system utilities can include private paths.
export const run: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 20_000, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout) =>
        resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout }),
    );
  });
export const label = (role: ServiceRole) => `org.ellie.assistant.${role}`;
export function serviceEnabled(output: string, role: ServiceRole): boolean {
  const name = label(role).replaceAll(".", "\\.");
  const value = output.match(new RegExp(`^\\s*"${name}"\\s*=>[ \t]*(.*?)[ \t]*$`, "m"))?.[1];
  if (value === undefined || value === "enabled" || value === "false") return true;
  if (value === "disabled" || value === "true") return false;
  throw new Error("Cannot interpret service enablement. Check the logged-in GUI session.");
}
const marker = "<!-- Managed by Ellie service install; version 1. -->";
function xml(value: string): string {
  if (
    [...value].some((char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))
  )
    throw new Error("Unsupported control character in service path.");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
export function servicePlist(
  role: ServiceRole,
  home: string,
  checkout: string,
  node: string,
): string {
  for (const path of [home, checkout, node])
    if (!isAbsolute(path)) throw new Error("Service paths must be absolute.");
  const str = (value: string) => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marker}
<plist version="1.0"><dict>
<key>Label</key>${str(label(role))}
<key>ProgramArguments</key><array>${[applicationExecutable(home, role), "--launch-agent"].map(str).join("")}</array>
<key>AssociatedBundleIdentifiers</key><array>${str(applicationId(role))}</array>
<key>WorkingDirectory</key>${str(checkout)}
<key>EnvironmentVariables</key><dict><key>HOME</key>${str(home)}<key>PATH</key>${str(`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</dict>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key>${str(role === "node" ? "Interactive" : "Standard")}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><false/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>Umask</key><integer>63</integer>
<key>SoftResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
<key>HardResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}
export async function privatePath(
  path: string,
  directory = false,
  uid = process.getuid?.(),
): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "Private state has unsafe ownership, permissions, or a symlink. See docs/services.md.",
    );
}
export interface ServiceStatus {
  role: ServiceRole;
  installed: boolean;
  guiSession: boolean;
  loaded: boolean;
  enabled: boolean | null;
  state: "running" | "waiting" | "stopped" | "unavailable";
  pid?: number;
  lastExitCode?: number;
}
export class Services {
  readonly home: string;
  readonly dir: string;
  readonly agents: string;
  readonly uid: number;
  readonly checkout: string;
  readonly node: string;
  private platform: string;
  private run: Run;
  private application: ServiceApplication;
  constructor(
    options: {
      home?: string;
      uid?: number;
      checkout?: string;
      node?: string;
      platform?: string;
      run?: Run;
      application?: ServiceApplication;
    } = {},
  ) {
    this.home = options.home ?? homedir();
    this.dir = join(this.home, ".ellie");
    this.agents = join(this.home, "Library", "LaunchAgents");
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.checkout = options.checkout ?? fileURLToPath(new URL("../../../", import.meta.url));
    this.node = options.node ?? process.execPath;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? run;
    this.application = options.application ?? new MacOSServiceApplication(this.home, this.uid);
  }
  private guard(): void {
    if (this.platform !== "darwin") throw new Error("Services require macOS.");
    if (this.uid <= 0) throw new Error("Run service commands as the logged-in user, without sudo.");
  }
  private get domain(): string {
    return `gui/${this.uid}`;
  }
  private target(role: ServiceRole): string {
    return `${this.domain}/${label(role)}`;
  }
  path(role: ServiceRole): string {
    return join(this.agents, `${label(role)}.plist`);
  }
  private async call(args: string[], hint: string): Promise<void> {
    if ((await this.run("/bin/launchctl", args)).code !== 0) throw new Error(hint);
  }
  private async gui(): Promise<boolean> {
    return (await this.run("/bin/launchctl", ["print", this.domain])).code === 0;
  }
  private async managed(role: ServiceRole): Promise<string | undefined> {
    try {
      await privatePath(this.path(role), false, this.uid);
      const text = await readFile(this.path(role), "utf8");
      if (!text.includes(marker) || !text.includes(`<string>${label(role)}</string>`))
        throw new Error("An unmanaged service file already exists. It was preserved.");
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async locked<T>(role: ServiceRole, action: () => Promise<T>): Promise<T> {
    this.guard();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await privatePath(this.dir, true, this.uid);
    const lock = join(this.dir, `service-${role}.lock`);
    try {
      await writeFile(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Another service command is running or was interrupted. See docs/services.md for lifecycle lock recovery.",
        );
      throw error;
    }
    try {
      return await action();
    } finally {
      await unlink(lock);
    }
  }
  async status(role: ServiceRole): Promise<ServiceStatus> {
    this.guard();
    const installed = (await this.managed(role)) !== undefined;
    const guiSession = await this.gui();
    if (!guiSession)
      return { role, installed, guiSession, loaded: false, enabled: null, state: "unavailable" };
    const disabled = await this.run("/bin/launchctl", ["print-disabled", this.domain]);
    if (disabled.code !== 0)
      throw new Error("Cannot inspect service enablement. Check the logged-in GUI session.");
    const enabled = serviceEnabled(disabled.stdout, role);
    const response = await this.run("/bin/launchctl", ["print", this.target(role)]);
    // 113 is launchctl's missing-service result; other failures must not look stopped.
    if (response.code !== 0 && response.code !== 113)
      throw new Error("Cannot inspect service state. Check the logged-in GUI session.");
    const loaded = response.code === 0;
    const pid = response.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    const lastExit = response.stdout.match(/^\s*last exit code = (-?\d+)\s*$/m)?.[1];
    return {
      role,
      installed,
      guiSession,
      loaded,
      enabled,
      state: loaded ? (pid ? "running" : "waiting") : "stopped",
      ...(pid ? { pid: Number(pid) } : {}),
      ...(lastExit ? { lastExitCode: Number(lastExit) } : {}),
    };
  }
  async validate(role: ServiceRole): Promise<void> {
    this.guard();
    const version = await this.run(this.node, ["--version"]);
    if (version.code !== 0 || !version.stdout.trim().startsWith("v24."))
      throw new Error(
        "Run service install/start with Node.js 24 on PATH. Bun remains the package manager.",
      );
    await access(join(this.checkout, "apps/cli/src/main.ts"), constants.R_OK);
    await access(this.node, constants.X_OK);
    await privatePath(this.dir, true, this.uid);
    if (role === "coordinator") await privatePath(join(this.dir, "auth.json"), false, this.uid);
    const configPath = join(this.dir, role === "coordinator" ? "server.json" : "node.json");
    await privatePath(configPath, false, this.uid);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (role === "coordinator") serverConfig(config);
    else nodeConfig(config);
    await privatePath(
      join(this.dir, role === "coordinator" ? "server-cert.pem" : "node-server-cert.pem"),
      false,
      this.uid,
    );
    await access(join(this.dir, "bin", "ellie-macos"), constants.X_OK);
  }
  async install(role: ServiceRole): Promise<void> {
    return this.locked(role, () => this.installUnlocked(role));
  }
  private async installUnlocked(role: ServiceRole): Promise<void> {
    await this.validate(role);
    const previous = await this.managed(role);
    const plist = servicePlist(
      role,
      this.home,
      await realpath(this.checkout),
      await realpath(this.node),
    );
    const checkout = await realpath(this.checkout);
    const node = await realpath(this.node);
    if (previous === plist && (await this.application.matches(role, checkout, node))) {
      await this.application.install(role, checkout, node);
      return;
    }
    if ((await this.status(role)).loaded)
      throw new Error(
        "Stop the service before installing changed application, runtime, or checkout paths.",
      );
    await ensureState(this.dir);
    await mkdir(this.agents, { recursive: true, mode: 0o700 });
    const info = await lstat(this.agents);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.uid || info.mode & 0o022)
      throw new Error("LaunchAgents directory has unsafe ownership, permissions, or a symlink.");
    const temp = join(this.agents, `.ellie-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, plist, { mode: 0o600, flag: "wx" });
      await this.callPlutil(temp);
      await this.application.install(role, checkout, node, () => rename(temp, this.path(role)));
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  private async callPlutil(path: string): Promise<void> {
    if ((await this.run("/usr/bin/plutil", ["-lint", path])).code !== 0)
      throw new Error(
        "Generated service definition failed plist validation; existing file preserved.",
      );
  }
  async start(role: ServiceRole): Promise<void> {
    return this.locked(role, () => this.startUnlocked(role));
  }
  private async startUnlocked(role: ServiceRole): Promise<void> {
    await this.validate(role);
    const status = await this.status(role);
    if (!status.installed) throw new Error("Install this service first.");
    if (!status.guiSession)
      throw new Error("Log in to this Mac's graphical desktop before starting services.");
    // A changed checkout or Node upgrade requires install again, not a stale executable.
    if (
      (await this.managed(role)) !==
        servicePlist(role, this.home, await realpath(this.checkout), await realpath(this.node)) ||
      !(await this.application.matches(
        role,
        await realpath(this.checkout),
        await realpath(this.node),
      ))
    )
      throw new Error(
        "Service application or paths changed. Stop and install the service again from the intended checkout.",
      );
    await this.call(["enable", this.target(role)], "Could not enable the service.");
    if (!status.loaded)
      await this.call(
        ["bootstrap", this.domain, this.path(role)],
        "Could not load the service. Run service status and doctor.",
      );
    if (status.state !== "running")
      await this.call(
        ["kickstart", this.target(role)],
        "Could not start the service. Run service status and doctor.",
      );
  }
  async stop(role: ServiceRole): Promise<void> {
    return this.locked(role, () => this.stopUnlocked(role));
  }
  private async stopUnlocked(role: ServiceRole): Promise<void> {
    const status = await this.status(role);
    if (!status.installed && !status.loaded) return;
    if (!status.guiSession)
      throw new Error("Log in to this Mac's graphical desktop to stop or uninstall the service.");
    await this.call(
      ["disable", this.target(role)],
      "Could not disable the service for future logins.",
    );
    if (status.loaded)
      await this.call(
        ["bootout", this.target(role)],
        "Could not stop the service; its files were preserved.",
      );
  }
  async uninstall(role: ServiceRole): Promise<void> {
    return this.locked(role, async () => {
      await this.stopUnlocked(role);
      if ((await this.managed(role)) !== undefined) await unlink(this.path(role));
      await this.application.uninstall(role);
    });
  }
}
