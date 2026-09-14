#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "Use: node scripts/test-native-voice.mjs --executable /path/whisper-cli --model /path/model.bin [--bridge /path/voice-transcribe.mjs]";
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (
    !["--executable", "--model", "--bridge"].includes(key) ||
    options.has(key) ||
    !value ||
    !isAbsolute(value) ||
    value.includes("\0")
  ) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  options.set(key, value);
}
if (!options.has("--executable") || !options.has("--model")) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

let active;
let interrupted = false;

function stop(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    interrupted = true;
    active?.cancel();
  });
}

async function run(executable, args, timeoutMs) {
  if (interrupted) throw new Error("interrupted");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: repository,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = Buffer.alloc(0);
    let failed = false;
    let killTimer;
    const cancel = () => {
      if (failed) return;
      failed = true;
      stop(child, "SIGTERM");
      killTimer = setTimeout(() => stop(child, "SIGKILL"), 1_000);
    };
    const operation = { cancel };
    active = operation;
    const timer = setTimeout(cancel, timeoutMs);
    child.stdout.on("data", (data) => {
      if (failed) return;
      if (output.length + data.length > 16_384) cancel();
      else output = Buffer.concat([output, data]);
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (active === operation) active = undefined;
      if (failed || interrupted || code !== 0) reject(new Error("process failed"));
      else resolvePromise(output);
    });
  });
}

let directory;
try {
  if (process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("runtime");
  const executable = options.get("--executable");
  const model = options.get("--model");
  const bridge = options.get("--bridge") ?? join(repository, "scripts/voice-transcribe.mjs");
  for (const path of [executable, model, bridge]) {
    if (!(await stat(path)).isFile()) throw new Error("configuration");
    await access(path, constants.R_OK | (path === executable ? constants.X_OK : 0));
  }
  directory = await mkdtemp(join(tmpdir(), "ellie-native-voice-check-"));
  await chmod(directory, 0o700);
  const source = join(directory, "synthetic.aiff");
  const audio = join(directory, "synthetic.wav");
  // The phrase is synthetic and is never played through speakers or sent as a command.
  await run("/usr/bin/say", ["-o", source, "Open Safari."], 30_000);
  await run(
    "/usr/bin/afconvert",
    ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", source, audio],
    15_000,
  );
  await chmod(source, 0o600);
  await chmod(audio, 0o600);
  const metadata = await stat(audio);
  if (metadata.size > 1_100_000) throw new Error("audio bound");
  const wav = await readFile(audio);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("audio format");
  const started = performance.now();
  const bytes = await run(
    process.execPath,
    [bridge, "--audio", audio, "--model", model, "--executable", executable],
    40_000,
  );
  const result = JSON.parse(bytes.toString("utf8"));
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    typeof result.text !== "string" ||
    result.text
      .trim()
      .replace(/[.!?]$/, "")
      .toLowerCase() !== "open safari"
  )
    throw new Error("transcription mismatch");
  await rm(directory, { recursive: true, force: true });
  directory = undefined;
  process.stdout.write(
    `${JSON.stringify({ synthesis: "passed", transcription: "passed", transcriptionMs: Math.round(performance.now() - started), transientFilesRemoved: true, microphone: "not_tested", desktopDispatch: "not_tested" })}\n`,
  );
} catch {
  process.stderr.write(
    "Native voice validation failed. Check macOS, Node 24, the explicitly configured local model and executable, and the bridge build. No microphone recording or command dispatch was attempted.\n",
  );
  process.exitCode = interrupted ? 130 : 1;
} finally {
  if (directory) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      process.stderr.write("Temporary synthetic voice test files could not be removed.\n");
      process.exitCode = 1;
    }
  }
}
