import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceRole } from "./services.ts";

export const applicationName = (role: ServiceRole) =>
  role === "node" ? "Ellie Node" : "Ellie Coordinator";
export const applicationId = (role: ServiceRole) => `org.ellie.assistant.${role}.app`;
export const applicationPath = (home: string, role: ServiceRole) =>
  join(home, "Applications", `${applicationName(role)}.app`);
export const applicationExecutable = (home: string, role: ServiceRole) =>
  join(applicationPath(home, role), "Contents/MacOS/EllieService");

export interface ServiceApplication {
  matches(role: ServiceRole, checkout: string, node: string): Promise<boolean>;
  install(
    role: ServiceRole,
    checkout: string,
    node: string,
    commit?: () => Promise<void>,
  ): Promise<void>;
  uninstall(role: ServiceRole): Promise<void>;
}

// Compiler/signing errors can contain private paths. Only fixed diagnostics escape.
async function command(file: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 256 * 1024 }, (error) => {
      if (error)
        reject(
          new Error(
            "Ellie application build or verification failed. Check Xcode Command Line Tools and reinstall the stopped service.",
          ),
        );
      else resolve();
    });
  });
}

async function owned(path: string, uid: number, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o022) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    throw new Error(
      "Ellie application has unsafe ownership, permissions, or a symlink; it was preserved.",
    );
}

export class MacOSServiceApplication implements ServiceApplication {
  private home: string;
  private uid: number;
  private source: string;
  private suffix: string;
  private register: boolean;
  private command: typeof command;
  constructor(
    home: string,
    uid: number,
    source = fileURLToPath(new URL("../../../", import.meta.url)),
    suffix = "",
    options: { register?: boolean; command?: typeof command } = {},
  ) {
    if (!/^[a-zA-Z0-9.-]*$/.test(suffix)) throw new Error("Invalid application identity suffix.");
    this.home = home;
    this.uid = uid;
    this.source = source;
    this.suffix = suffix;
    this.register = options.register ?? true;
    this.command = options.command ?? command;
  }
  private async inputs(role: ServiceRole, checkout: string, node: string) {
    const swift = await readFile(join(this.source, "packages/macos/native/EllieService.swift"));
    const icon = await readFile(join(this.source, "packages/macos/assets/Ellie.png"));
    const runtime = JSON.stringify({
      node,
      entrypoint: join(checkout, "apps/cli/src/main.ts"),
      role,
    });
    const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${applicationId(role)}${this.suffix}</string>
<key>CFBundleName</key><string>${applicationName(role)}</string>
<key>CFBundleDisplayName</key><string>${applicationName(role)}</string>
<key>CFBundleExecutable</key><string>EllieService</string>
<key>CFBundleIconFile</key><string>Ellie</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
    const digest = createHash("sha256")
      .update(swift)
      .update(icon)
      .update(runtime)
      .update(info)
      .digest("hex");
    return { swift, icon, runtime, info, digest };
  }
  private async managed(role: ServiceRole): Promise<{ digest: string } | undefined> {
    const app = applicationPath(this.home, role);
    try {
      await lstat(app);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    await owned(dirname(app), this.uid, true);
    await owned(app, this.uid, true);
    for (const folder of ["Contents", "Contents/Resources", "Contents/MacOS"])
      await owned(join(app, folder), this.uid, true);
    const manifest = join(app, "Contents/Resources/ellie-build.json");
    let data;
    try {
      await owned(manifest, this.uid, false);
      data = JSON.parse(await readFile(manifest, "utf8"));
    } catch {
      throw new Error("An unmanaged Ellie application already exists; it was preserved.");
    }
    if (
      !data ||
      typeof data !== "object" ||
      data.managedBy !== "ellie-service-v1" ||
      data.role !== role ||
      !/^[a-f0-9]{64}$/.test(data.digest)
    )
      throw new Error("An unmanaged Ellie application already exists; it was preserved.");
    return data;
  }
  async matches(role: ServiceRole, checkout: string, node: string): Promise<boolean> {
    const previous = await this.managed(role);
    if (!previous || previous.digest !== (await this.inputs(role, checkout, node)).digest)
      return false;
    try {
      await this.command("/usr/bin/codesign", [
        "--verify",
        "--strict",
        applicationPath(this.home, role),
      ]);
    } catch {
      return false;
    }
    return true;
  }
  async install(
    role: ServiceRole,
    checkout: string,
    node: string,
    commit?: () => Promise<void>,
  ): Promise<void> {
    if (await this.matches(role, checkout, node)) {
      if (this.register) await this.command(applicationExecutable(this.home, role), ["--register"]);
      await commit?.();
      return;
    }
    const previous = await this.managed(role);
    const input = await this.inputs(role, checkout, node);
    const app = applicationPath(this.home, role);
    const parent = dirname(app);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await owned(parent, this.uid, true);
    const staging = join(parent, `.ellie-${randomUUID()}.app`);
    const backup = join(parent, `.ellie-${randomUUID()}.previous.app`);
    let backedUp = false;
    try {
      const resources = join(staging, "Contents/Resources");
      const executable = join(staging, "Contents/MacOS/EllieService");
      await mkdir(resources, { recursive: true, mode: 0o700 });
      await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
      const work = join(staging, "build");
      await mkdir(join(work, "Ellie.iconset"), { recursive: true, mode: 0o700 });
      await writeFile(join(work, "EllieService.swift"), input.swift, { mode: 0o600 });
      await writeFile(join(work, "Ellie.png"), input.icon, { mode: 0o600 });
      await this.command("/usr/bin/xcrun", [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-parse-as-library",
        join(work, "EllieService.swift"),
        "-o",
        executable,
      ]);
      await chmod(executable, 0o700);
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          await this.command("/usr/bin/sips", [
            "-z",
            String(size * scale),
            String(size * scale),
            join(work, "Ellie.png"),
            "--out",
            join(work, "Ellie.iconset", `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
          ]);
        }
      }
      await this.command("/usr/bin/iconutil", [
        "-c",
        "icns",
        join(work, "Ellie.iconset"),
        "-o",
        join(resources, "Ellie.icns"),
      ]);
      await writeFile(join(staging, "Contents/Info.plist"), input.info, { mode: 0o600 });
      await writeFile(join(resources, "runtime.json"), input.runtime, { mode: 0o600 });
      await writeFile(
        join(resources, "ellie-build.json"),
        JSON.stringify({ managedBy: "ellie-service-v1", role, digest: input.digest }),
        { mode: 0o600 },
      );
      await rm(work, { recursive: true });
      await this.command("/usr/bin/plutil", ["-lint", join(staging, "Contents/Info.plist")]);
      await this.command("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--identifier",
        applicationId(role) + this.suffix,
        staging,
      ]);
      await this.command("/usr/bin/codesign", ["--verify", "--strict", staging]);
      if (previous) {
        await rename(app, backup);
        backedUp = true;
      }
      try {
        await rename(staging, app);
        // Public LaunchServices registration lets Settings resolve the app name/icon.
        // It does not grant or reset any privacy permission.
        if (this.register)
          await this.command(applicationExecutable(this.home, role), ["--register"]);
        await commit?.();
      } catch (error) {
        // Preserve the previous application even if registration fails after publication.
        // If restoration itself fails, keep the backup for manual recovery.
        if (backedUp) {
          backedUp = false;
          await rm(app, { recursive: true, force: true });
          await rename(backup, app);
        } else {
          await rm(app, { recursive: true, force: true });
        }
        throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (backedUp) await rm(backup, { recursive: true, force: true });
    }
  }
  async uninstall(role: ServiceRole): Promise<void> {
    if (!(await this.managed(role))) return;
    const app = applicationPath(this.home, role);
    await rm(app, { recursive: true });
  }
}
