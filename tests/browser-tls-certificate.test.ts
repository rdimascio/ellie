import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { generateBrowserTlsIdentity, validateLocalHostname } from "../apps/cli/src/certificate.ts";

const openssl = "/usr/bin/openssl";
const execute = promisify(execFile);

test("browser TLS generation creates a constrained CA and one server leaf", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ellie-browser-tls-test-"));
  try {
    const identity = await generateBrowserTlsIdentity("living-room.local", {
      openssl,
      tempDir: parent,
    });
    assert.equal(identity.hostname, "living-room.local");
    assert.ok(
      new X509Certificate(identity.rootCert).checkPrivateKey(createPrivateKey(identity.rootKey)),
    );
    assert.ok(
      new X509Certificate(identity.leafCert).checkPrivateKey(createPrivateKey(identity.leafKey)),
    );

    const inspectDir = await mkdtemp(join(tmpdir(), "ellie-browser-tls-inspect-"));
    try {
      const rootPath = join(inspectDir, "root.pem");
      const leafPath = join(inspectDir, "leaf.pem");
      await writeFile(rootPath, identity.rootCert);
      await writeFile(leafPath, identity.leafCert);
      const [{ stdout: rootText }, { stdout: leafText }] = await Promise.all([
        execute(openssl, ["x509", "-in", rootPath, "-noout", "-text"]),
        execute(openssl, ["x509", "-in", leafPath, "-noout", "-text"]),
      ]);
      assert.match(rootText, /Signature Algorithm: sha256WithRSAEncryption/);
      assert.match(rootText, /Public-Key: \(2048 bit\)/);
      assert.match(rootText, /CA:TRUE, pathlen:0/);
      assert.match(rootText, /Certificate Sign, CRL Sign/);
      assert.match(rootText, /X509v3 Name Constraints: critical/);
      assert.match(rootText, /DNS:living-room\.local/);
      assert.match(leafText, /Signature Algorithm: sha256WithRSAEncryption/);
      assert.match(leafText, /Public-Key: \(2048 bit\)/);
      assert.match(leafText, /CA:FALSE/);
      assert.match(leafText, /TLS Web Server Authentication/);
      assert.match(leafText, /DNS:living-room\.local/);
      assert.doesNotMatch(leafText, /DNS:[^\n]*,/);
      const leaf = new X509Certificate(identity.leafCert);
      assert.equal(leaf.checkHost("living-room.local"), "living-room.local");
      assert.equal(leaf.checkHost("other.local"), undefined);
      assert.ok((Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 86_400_000 <= 397);
      await execute(openssl, ["verify", "-CAfile", rootPath, "-purpose", "sslserver", leafPath]);
    } finally {
      await rm(inspectDir, { recursive: true, force: true });
    }
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("browser TLS generation rejects non-canonical or multi-label hostnames before running", async () => {
  for (const hostname of [
    "Living-Room.local",
    "living-room.local.",
    "a.b.local",
    "-host.local",
    "host.example",
    "host\n.local",
  ]) {
    assert.throws(() => validateLocalHostname(hostname), /canonical single-label/);
  }
  assert.equal(validateLocalHostname("living-room.local"), "living-room.local");
});

test("browser TLS generation uses absolute fixed invocations, private files, and cleans up on failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ellie-browser-tls-failure-"));
  let calls = 0;
  try {
    await assert.rejects(
      generateBrowserTlsIdentity("host.local", {
        openssl,
        tempDir: parent,
        run: async (file, args) => {
          calls += 1;
          assert.equal(file, openssl);
          assert.ok(args.every((arg) => !arg.includes("host.local\n")));
          const keyIndex = args.indexOf("-keyout");
          const configIndex = args.indexOf("-config");
          if (configIndex >= 0)
            assert.equal((await stat(args[configIndex + 1]!)).mode & 0o777, 0o600);
          if (keyIndex >= 0) {
            const keyPath = args[keyIndex + 1]!;
            assert.equal((await stat(dirname(keyPath))).mode & 0o777, 0o700);
          }
          throw Object.assign(new Error("PRIVATE KEY secret"), {
            code: 1,
            stderr: "PRIVATE KEY secret",
          });
        },
      }),
      (error) => {
        assert.equal(
          String(error),
          "Error: Certificate creation failed: openssl exited unsuccessfully.",
        );
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(parent), []);
    await assert.rejects(
      generateBrowserTlsIdentity("host.local", { openssl: "openssl" }),
      /path must be absolute/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
