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
const execute = (file: string, args: string[]) =>
  promisify(execFile)(file, args, { timeout: 30_000, maxBuffer: 64 * 1024 });

test("browser TLS generation creates a constrained CA and one server leaf", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ellie-browser-tls-test-"));
  try {
    const identity = await generateBrowserTlsIdentity("living-room.local", {
      openssl,
      tempDir: parent,
    });
    assert.equal(identity.hostname, "living-room.local");
    const generatedRoot = new X509Certificate(identity.rootCert);
    const generatedLeaf = new X509Certificate(identity.leafCert);
    assert.equal(generatedRoot.ca, true);
    assert.ok(generatedRoot.checkPrivateKey(createPrivateKey(identity.rootKey)));
    assert.ok(generatedRoot.verify(generatedRoot.publicKey));
    assert.equal(generatedLeaf.ca, false);
    assert.ok(generatedLeaf.checkPrivateKey(createPrivateKey(identity.leafKey)));
    assert.ok(generatedLeaf.verify(generatedRoot.publicKey));
    assert.deepEqual(generatedLeaf.keyUsage, ["1.3.6.1.5.5.7.3.1"]);

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
      assert.match(rootText, /IP:0\.0\.0\.0\/0\.0\.0\.0/);
      assert.match(rootText, /IP:0:0:0:0:0:0:0:0\/0:0:0:0:0:0:0:0/);
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

      const verifyRejectedSan = async (name: string, san: string) => {
        const configPath = join(inspectDir, `${name}.cnf`);
        const keyPath = join(inspectDir, `${name}-key.pem`);
        const requestPath = join(inspectDir, `${name}.csr`);
        const certPath = join(inspectDir, `${name}.pem`);
        const serialPath = join(inspectDir, `${name}.srl`);
        await writeFile(
          configPath,
          `[req]\nprompt=no\ndistinguished_name=subject\nreq_extensions=leaf_ext\n[subject]\nCN=rejected.local\n[leaf_ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
          { mode: 0o600 },
        );
        await execute(openssl, [
          "req",
          "-new",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          requestPath,
          "-config",
          configPath,
        ]);
        await execute(openssl, [
          "x509",
          "-req",
          "-sha256",
          "-in",
          requestPath,
          "-CA",
          rootPath,
          "-CAkey",
          join(inspectDir, "root-key.pem"),
          "-CAserial",
          serialPath,
          "-CAcreateserial",
          "-out",
          certPath,
          "-days",
          "30",
          "-extfile",
          configPath,
          "-extensions",
          "leaf_ext",
        ]);
        await assert.rejects(
          execute(openssl, ["verify", "-CAfile", rootPath, "-purpose", "sslserver", certPath]),
        );
      };
      await writeFile(join(inspectDir, "root-key.pem"), identity.rootKey, { mode: 0o600 });
      await verifyRejectedSan("dns", "DNS:other.local");
      await verifyRejectedSan("ipv4", "IP:127.0.0.1");
      await verifyRejectedSan("ipv6", "IP:::1");
    } finally {
      await rm(inspectDir, { recursive: true, force: true });
    }
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("browser TLS generation rejects a matching leaf key signed by a different CA", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ellie-browser-tls-chain-"));
  try {
    await assert.rejects(
      generateBrowserTlsIdentity("host.local", {
        openssl,
        tempDir: parent,
        run: async (file, args) => {
          if (args[0] !== "x509") return execute(file, args);
          const outputPath = args[args.indexOf("-out") + 1]!;
          const dir = dirname(outputPath);
          const rogueKey = join(dir, "rogue-key.pem");
          const rogueCert = join(dir, "rogue-cert.pem");
          await execute(file, [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-nodes",
            "-keyout",
            rogueKey,
            "-out",
            rogueCert,
            "-days",
            "30",
            "-subj",
            "/CN=Rogue CA",
          ]);
          const changed = [...args];
          changed[changed.indexOf("-CA") + 1] = rogueCert;
          changed[changed.indexOf("-CAkey") + 1] = rogueKey;
          return execute(file, changed);
        },
      }),
      /invalid browser TLS identity \(leaf-signature\)/,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("browser TLS validation reports fixed parse, key and profile categories", async () => {
  for (const kind of ["parse", "key", "profile"] as const) {
    const parent = await mkdtemp(join(tmpdir(), `ellie-browser-tls-${kind}-`));
    try {
      await assert.rejects(
        generateBrowserTlsIdentity("host.local", {
          openssl,
          tempDir: parent,
          run: async (file, args) => {
            if (args[0] !== "x509") return execute(file, args);
            if (kind === "profile") {
              const config = args[args.indexOf("-extfile") + 1]!;
              await writeFile(
                config,
                "[leaf_ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=DNS:host.local\n",
                { mode: 0o600 },
              );
            }
            const result = await execute(file, args);
            const output = args[args.indexOf("-out") + 1]!;
            if (kind === "parse") await writeFile(output, "PRIVATE KEY secret\n");
            if (kind === "key") {
              const leafKey = join(dirname(output), "leaf-key.pem");
              await execute(file, [
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
                "-out",
                leafKey,
              ]);
            }
            return result;
          },
        }),
        (error) => {
          const expected =
            kind === "parse" ? "parse" : kind === "key" ? "leaf-key" : "leaf-profile";
          assert.equal(
            String(error),
            `Error: Certificate creation failed: openssl produced an invalid browser TLS identity (${expected}).`,
          );
          assert.doesNotMatch(String(error), /PRIVATE KEY secret|ellie-browser-tls-/);
          return true;
        },
      );
      assert.deepEqual(await readdir(parent), []);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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
