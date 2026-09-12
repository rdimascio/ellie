import { freemem, totalmem, cpus, loadavg } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { record, telemetry } from "@ellie/protocol";
import type { Telemetry } from "@ellie/protocol";

export function batteryState(
  output: string,
): Pick<Telemetry["power"], "source" | "batteryPercent"> {
  const source = output.includes("'AC Power'")
    ? "ac"
    : output.includes("'Battery Power'")
      ? "battery"
      : "unknown";
  const match = output.match(/(\d{1,3})%/);
  return { source, batteryPercent: match && Number(match[1]) <= 100 ? Number(match[1]) : null };
}

export function memoryForAdmission(
  nativeHealth: unknown,
  freeMemoryBytes: number,
  totalMemoryBytes: number,
): number {
  try {
    const available = record(nativeHealth).availableMemoryBytes;
    if (
      typeof available === "number" &&
      Number.isSafeInteger(available) &&
      available >= 0 &&
      available <= totalMemoryBytes
    ) {
      return available;
    }
  } catch {}
  return freeMemoryBytes;
}

export async function collectTelemetry(
  activeJobs: number,
  roundTripMs: number | null,
  health?: () => Promise<unknown>,
): Promise<Telemetry> {
  let power: Telemetry["power"] = { source: "unknown", batteryPercent: null, lowPowerMode: null };
  let thermal: Telemetry["thermal"] = "unknown";
  const totalMemoryBytes = totalmem();
  const conservativeFreeMemoryBytes = freemem();
  let freeMemoryBytes = conservativeFreeMemoryBytes;
  if (process.platform === "darwin") {
    const [battery, native] = await Promise.allSettled([
      promisify(execFile)("/usr/bin/pmset", ["-g", "batt"], { timeout: 2000, maxBuffer: 8192 }),
      health?.() ?? Promise.resolve({}),
    ]);
    if (battery.status === "fulfilled") power = { ...power, ...batteryState(battery.value.stdout) };
    if (native.status === "fulfilled") {
      const state = record(native.value);
      if (["nominal", "fair", "serious", "critical"].includes(String(state.thermal)))
        thermal = state.thermal as Telemetry["thermal"];
      if (typeof state.lowPowerMode === "boolean") power.lowPowerMode = state.lowPowerMode;
      freeMemoryBytes = memoryForAdmission(state, conservativeFreeMemoryBytes, totalMemoryBytes);
    }
  }
  return telemetry({
    freeMemoryBytes,
    totalMemoryBytes,
    activeJobs,
    load: (loadavg()[0] ?? 0) / Math.max(1, cpus().length),
    power,
    thermal,
    network: {
      roundTripMs,
      quality: roundTripMs === null ? "unknown" : roundTripMs > 500 ? "poor" : "good",
    },
  });
}
