import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateKey, X509Certificate } from "node:crypto";

export type CertificateRunner = (file: string, args: string[]) => Promise<unknown>;
const run: CertificateRunner = (file, args) =>
  promisify(execFile)(file, args, { timeout: 30_000, maxBuffer: 64 * 1024 });

/** Explicit paths work with both macOS LibreSSL and OpenSSL; '-' is not portable. */
export async function generateCertificate(
  options: { openssl?: string; run?: CertificateRunner; tempDir?: string } = {},
): Promise<{ key: string; cert: string }> {
  const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), "ellie-cert-"));
  try {
    await chmod(dir, 0o700);
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    try {
      await (options.run ?? run)(options.openssl ?? "openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "365",
        "-subj",
        "/CN=ellie.local",
      ]);
    } catch (error) {
      // Never echo subprocess stdout/stderr: it can contain generated key material.
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT")
        throw new Error("Certificate creation failed: openssl executable was not found on PATH.");
      if (e.killed) throw new Error("Certificate creation failed: openssl timed out.");
      throw new Error(
        `Certificate creation failed: openssl exited unsuccessfully (${e.code ?? "unknown status"}). Check the openssl installation and temporary-directory permissions.`,
      );
    }
    const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
    try {
      if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key)))
        throw new Error("mismatch");
    } catch {
      throw new Error(
        "Certificate creation failed: openssl did not produce a valid matching certificate and private key.",
      );
    }
    return { key, cert };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
