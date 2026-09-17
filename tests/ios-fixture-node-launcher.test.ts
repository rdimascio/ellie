import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureNodeLauncher } from "../scripts/ios-fixture-node-launcher.mjs";

test("ATS fake transcriber uses exact Node with a restricted PATH and spaced owned paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie node fixture ' with spaces "));
  const emptyPath = join(directory, "empty PATH");
  const script = join(directory, "fake transcriber.mjs");
  const original = join(directory, "original env launcher");
  const corrected = join(directory, "corrected launcher");
  try {
    await mkdir(emptyPath);
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", {
      mode: 0o600,
    });
    await writeFile(original, "#!/usr/bin/env node\nprocess.stdout.write('started')\n", {
      mode: 0o700,
    });
    await writeFile(corrected, fixtureNodeLauncher(process.execPath, script), { mode: 0o700 });
    await chmod(original, 0o700);
    await chmod(corrected, 0o700);
    const options = {
      env: { PATH: emptyPath },
      encoding: "utf8" as const,
      timeout: 3_000,
      killSignal: "SIGKILL" as const,
      maxBuffer: 4_096,
    };
    const before = spawnSync(original, [], options);
    assert.equal(before.status, 127, "env could not resolve node in the restricted PATH");
    const after = spawnSync(corrected, ["-m", "model with spaces", "$literal"], options);
    assert.equal(after.error, undefined);
    assert.equal(after.status, 0);
    assert.equal(after.stdout, '["-m","model with spaces","$literal"]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
