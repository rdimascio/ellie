import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { generateCertificate } from "../apps/cli/src/certificate.ts";

test("certificate generation uses private explicit paths and cleans up without stdout dependence", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ellie-cert-test-"));
  try {
    const { key, cert } = await generateCertificate({
      tempDir,
      run: async (_file, args) => {
        const keyPath = args[args.indexOf("-keyout") + 1]!;
        assert.notEqual(keyPath, "-");
        assert.equal((await stat(dirname(keyPath))).mode & 0o777, 0o700);
        await promisify(execFile)(
          process.platform === "darwin" ? "/usr/bin/openssl" : "openssl",
          args,
        );
        return { stdout: "" }; // LibreSSL need not send the key to stdout.
      },
    });
    assert.ok(new X509Certificate(cert).checkPrivateKey(createPrivateKey(key)));
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("missing executable and command failures are distinct, sanitized, and clean up", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ellie-cert-errors-"));
  try {
    await assert.rejects(
      generateCertificate({ tempDir, openssl: join(tempDir, "missing") }),
      /not found on PATH/,
    );
    await assert.rejects(
      generateCertificate({
        tempDir,
        run: async () => {
          throw Object.assign(new Error("PRIVATE KEY secret"), {
            code: 1,
            stderr: "PRIVATE KEY secret",
          });
        },
      }),
      (error) => {
        assert.match(String(error), /exited unsuccessfully/);
        assert.doesNotMatch(String(error), /PRIVATE KEY|secret/);
        return true;
      },
    );
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
