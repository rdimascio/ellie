import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { privatePath } from "./services.ts";
import type { ServiceRole } from "./services.ts";

export const SERVICE_EVENTS = [
  "starting",
  "ready",
  "browser_ready",
  "browser_unavailable",
  "connected",
  "reconnecting",
  "stopping",
  "failed",
  "configuration_missing",
  "port_in_use",
  "permission_denied",
] as const;
export type ServiceEvent = (typeof SERVICE_EVENTS)[number];
export interface LogEntry {
  time: string;
  role: ServiceRole;
  event: ServiceEvent;
}
const LIMIT = 128 * 1024;
// Persist only known event names. No error strings, process output, job bodies, IDs,
// endpoints, model names, or credentials can enter this format.
export class ServiceLog {
  private constructor(privateDir: string, role: ServiceRole) {
    this.path = join(privateDir, `${role}.jsonl`);
    this.role = role;
  }
  private path: string;
  private role: ServiceRole;
  private last?: ServiceEvent;
  private lastAt = 0;
  static async open(state: string, role: ServiceRole): Promise<ServiceLog> {
    await privatePath(state, true);
    const dir = join(state, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await privatePath(dir, true);
    return new ServiceLog(dir, role);
  }
  write(event: ServiceEvent): void {
    if (!(SERVICE_EVENTS as readonly string[]).includes(event))
      throw new Error("Invalid service event.");
    const now = Date.now();
    // Repeated disconnect notices cannot grow a log faster than once per minute.
    if (this.last === event && now - this.lastAt < 60_000) return;
    const line =
      JSON.stringify({ time: new Date(now).toISOString(), role: this.role, event }) + "\n";
    let fd = openSync(
      this.path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw new Error("Unsafe service log file.");
      if (info.size + Buffer.byteLength(line) > LIMIT) {
        closeSync(fd);
        fd = -1;
        // Atomic rename replaces any old backup entry without following it.
        renameSync(this.path, `${this.path}.1`);
        fd = openSync(
          this.path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      }
      writeSync(fd, line);
      this.last = event;
      this.lastAt = now;
    } finally {
      if (fd !== -1) closeSync(fd);
    }
  }
}
export function failureEvent(error: unknown): ServiceEvent {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT":
      return "configuration_missing";
    case "EADDRINUSE":
      return "port_in_use";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    default:
      return "failed";
  }
}
export async function serviceLogs(state: string, role: ServiceRole): Promise<LogEntry[]> {
  await privatePath(state, true);
  const dir = join(state, "logs");
  try {
    await privatePath(dir, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: LogEntry[] = [];
  for (const name of [`${role}.jsonl.1`, `${role}.jsonl`]) {
    let fd: number;
    try {
      fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw new Error("Unsafe service log file.");
      const buffer = Buffer.alloc(Math.min(info.size, LIMIT));
      const length = readSync(fd, buffer, 0, buffer.length, Math.max(0, info.size - LIMIT));
      for (const line of buffer.toString("utf8", 0, length).split("\n")) {
        try {
          const value = JSON.parse(line);
          if (
            value.role === role &&
            (SERVICE_EVENTS as readonly unknown[]).includes(value.event) &&
            typeof value.time === "string" &&
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time)
          )
            entries.push({ time: value.time, role, event: value.event });
        } catch {
          /* Ignore truncated or foreign entries; never echo raw input. */
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  return entries.slice(-100);
}
