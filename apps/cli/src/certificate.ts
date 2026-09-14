import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateKey, X509Certificate } from "node:crypto";

export type CertificateRunner = (file: string, args: string[]) => Promise<unknown>;
const run: CertificateRunner = (file, args) =>
  promisify(execFile)(file, args, { timeout: 30_000, maxBuffer: 64 * 1024 });

const defaultOpenSsl =
  process.platform === "win32"
    ? "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe"
    : "/usr/bin/openssl";

function certificateFailure(error: unknown): Error {
  // Never echo subprocess stdout/stderr: it can contain generated key material.
  const failure = error as NodeJS.ErrnoException & { killed?: boolean };
  if (failure.code === "ENOENT")
    return new Error("Certificate creation failed: openssl executable was not found.");
  if (failure.killed) return new Error("Certificate creation failed: openssl timed out.");
  return new Error("Certificate creation failed: openssl exited unsuccessfully.");
}

export function validateLocalHostname(hostname: string): string {
  if (hostname.length > 69 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(hostname)) {
    throw new Error("Browser TLS hostname must be a canonical single-label .local DNS name.");
  }
  return hostname;
}

export type BrowserTlsIdentity = {
  hostname: string;
  rootKey: string;
  rootCert: string;
  leafKey: string;
  leafCert: string;
};

/**
 * Creates a private CA and one constrained browser-server leaf. The caller must
 * explicitly persist the keys in a secret store and distribute only rootCert.
 */
export async function generateBrowserTlsIdentity(
  hostname: string,
  options: { openssl?: string; run?: CertificateRunner; tempDir?: string } = {},
): Promise<BrowserTlsIdentity> {
  const canonicalHostname = validateLocalHostname(hostname);
  const openssl = options.openssl ?? defaultOpenSsl;
  if (!isAbsolute(openssl))
    throw new Error("Certificate creation failed: openssl path must be absolute.");

  const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), "ellie-browser-tls-"));
  try {
    await chmod(dir, 0o700);
    const paths = {
      rootConfig: join(dir, "root.cnf"),
      leafConfig: join(dir, "leaf.cnf"),
      rootKey: join(dir, "root-key.pem"),
      rootCert: join(dir, "root-cert.pem"),
      leafKey: join(dir, "leaf-key.pem"),
      leafRequest: join(dir, "leaf.csr"),
      leafCert: join(dir, "leaf-cert.pem"),
      serial: join(dir, "root-cert.srl"),
    };
    const rootConfig = `[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = root_ext\n[subject]\nCN = Ellie Local Browser CA\n[root_ext]\nbasicConstraints = critical,CA:true,pathlen:0\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always\nnameConstraints = critical,permitted;DNS:${canonicalHostname},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0\n`;
    const leafConfig = `[req]\nprompt = no\ndistinguished_name = subject\nreq_extensions = leaf_ext\n[subject]\nCN = ${canonicalHostname}\n[leaf_ext]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:${canonicalHostname}\nsubjectKeyIdentifier = hash\n`;
    await Promise.all([
      writeFile(paths.rootConfig, rootConfig, { mode: 0o600 }),
      writeFile(paths.leafConfig, leafConfig, { mode: 0o600 }),
    ]);

    const invoke = options.run ?? run;
    try {
      await invoke(openssl, [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        paths.rootKey,
        "-out",
        paths.rootCert,
        "-days",
        "3650",
        "-config",
        paths.rootConfig,
        "-extensions",
        "root_ext",
      ]);
      await chmod(paths.rootKey, 0o600);
      await invoke(openssl, [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        paths.leafKey,
        "-out",
        paths.leafRequest,
        "-config",
        paths.leafConfig,
      ]);
      await chmod(paths.leafKey, 0o600);
      await invoke(openssl, [
        "x509",
        "-req",
        "-sha256",
        "-in",
        paths.leafRequest,
        "-CA",
        paths.rootCert,
        "-CAkey",
        paths.rootKey,
        "-CAserial",
        paths.serial,
        "-CAcreateserial",
        "-out",
        paths.leafCert,
        "-days",
        "397",
        "-extfile",
        paths.leafConfig,
        "-extensions",
        "leaf_ext",
      ]);
    } catch (error) {
      throw certificateFailure(error);
    }

    const [rootKey, rootCert, leafKey, leafCert] = await Promise.all([
      readFile(paths.rootKey, "utf8"),
      readFile(paths.rootCert, "utf8"),
      readFile(paths.leafKey, "utf8"),
      readFile(paths.leafCert, "utf8"),
    ]);
    try {
      const root = new X509Certificate(rootCert);
      const leaf = new X509Certificate(leafCert);
      const now = Date.now();
      const leafStart = leaf.validFromDate.getTime();
      const leafEnd = leaf.validToDate.getTime();
      if (
        !root.ca ||
        !root.checkPrivateKey(createPrivateKey(rootKey)) ||
        !root.verify(root.publicKey) ||
        leaf.ca ||
        !leaf.checkPrivateKey(createPrivateKey(leafKey)) ||
        !leaf.verify(root.publicKey) ||
        leaf.subjectAltName !== `DNS:${canonicalHostname}` ||
        leaf.checkHost(canonicalHostname) !== canonicalHostname ||
        !leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
        leafStart > now + 5 * 60_000 ||
        leafEnd <= now ||
        leafEnd - leafStart > 397 * 86_400_000
      )
        throw new Error();
    } catch {
      throw new Error(
        "Certificate creation failed: openssl produced an invalid browser TLS identity.",
      );
    }
    return { hostname: canonicalHostname, rootKey, rootCert, leafKey, leafCert };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
