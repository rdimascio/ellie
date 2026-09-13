#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};
const owned = mkdtempSync(join(tmpdir(), "ellie-ios-ats-"));
const resultBundle = resolve(root, "test-results/native-ios-ats.xcresult");
const sockets = new Set();
let simulatorID,
  server,
  activeChild,
  interruptChild,
  requestedSignal,
  succeeded = false;
let acceptedRequests = 0,
  unexpectedRequests = 0;

function terminate(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function execute(file, args, { capture = false, timeout = 30_000, cleanup = false } = {}) {
  if (requestedSignal && !cleanup)
    return Promise.reject(new Error("iOS transport test interrupted."));
  return new Promise((resolvePromise, reject) => {
    let stdout = "",
      failure,
      killTimer;
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    activeChild = child;
    function stop(message) {
      failure ??= new Error(message);
      terminate(child, "SIGTERM");
      killTimer ??= setTimeout(() => terminate(child, "SIGKILL"), 5_000);
    }
    interruptChild = () => stop("iOS transport test interrupted.");
    if (capture)
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        if (stdout.length + chunk.length > 1_048_576) stop("Command output exceeded its bound.");
        else stdout += chunk;
      });
    const timer = setTimeout(() => stop(`${file} exceeded its deadline.`), timeout);
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (activeChild === child) {
        activeChild = undefined;
        interruptChild = undefined;
      }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${file} exited with ${signal ?? code}.`));
      else resolvePromise(stdout.trim());
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    interruptChild?.();
  });
}

try {
  rmSync(resultBundle, { recursive: true, force: true });
  mkdirSync(dirname(resultBundle), { recursive: true });
  const cert = join(owned, "cert.pem"),
    key = join(owned, "key.pem"),
    der = join(owned, "cert.der");
  const config = join(owned, "openssl.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=server",
      "prompt=no",
      "[dn]",
      "CN=127.0.0.1",
      "[server]",
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-config",
    config,
  ]);
  await execute("openssl", ["x509", "-in", cert, "-outform", "DER", "-out", der]);
  const pin = createHash("sha256").update(readFileSync(der)).digest("hex");
  const created = Date.now();
  const token = "c".repeat(64);
  const body = JSON.stringify({
    client: {
      id: "native-ats-test",
      role: "native_phone_controller",
      label: "Phone",
      grants: [{ target: "studio-mac", capabilities: ["app.open"] }],
      createdAt: created,
      expiresAt: created + 90 * 24 * 60 * 60 * 1_000,
    },
  });
  server = createServer(
    {
      cert: readFileSync(cert),
      key: readFileSync(key),
      minVersion: "TLSv1.2",
      headersTimeout: 5_000,
      requestTimeout: 5_000,
      keepAliveTimeout: 1_000,
    },
    (request, response) => {
      const valid =
        request.method === "GET" &&
        request.url === "/native/v1/session" &&
        request.headers["x-ellie-version"] === "1" &&
        request.headers.authorization === `Bearer ${token}` &&
        request.headers.cookie === undefined &&
        request.headers.origin === undefined &&
        !Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-"));
      if (valid) acceptedRequests += 1;
      else unexpectedRequests += 1;
      response.writeHead(valid ? 200 : 400, { "content-type": "application/json" });
      response.end(valid ? body : "{}");
    },
  );
  server.maxConnections = 8;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no loopback port.");
  const origin = `https://127.0.0.1:${address.port}`;

  const runtimes = JSON.parse(
    await execute("xcrun", ["simctl", "list", "runtimes", "--json"], {
      capture: true,
      timeout: 15_000,
    }),
  )
    .runtimes.filter(
      (item) =>
        item.isAvailable &&
        item.identifier?.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        Number(item.version?.split(".")[0]) >= 17,
    )
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!runtimes.length)
    throw new Error("No available iOS 17 or newer Simulator runtime was found.");
  const compatible =
    runtimes[0].supportedDeviceTypes?.filter((item) => item.productFamily === "iPhone") ?? [];
  const device = compatible.find((item) => item.name === "iPhone 16") ?? compatible[0];
  if (!device) throw new Error("The selected iOS runtime has no supported iPhone.");
  simulatorID = await execute(
    "xcrun",
    [
      "simctl",
      "create",
      `Ellie iOS ATS Tests ${randomUUID().slice(0, 8)}`,
      device.identifier,
      runtimes[0].identifier,
    ],
    { capture: true },
  );
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorID)) {
    simulatorID = undefined;
    throw new Error("Simulator creation returned an invalid identifier.");
  }
  await execute("xcrun", ["simctl", "boot", simulatorID]);
  await execute("xcrun", ["simctl", "bootstatus", simulatorID, "-b"], { timeout: 180_000 });
  await execute(
    "xcodebuild",
    [
      "-quiet",
      "-project",
      "apps/ios/EllieIOS.xcodeproj",
      "-scheme",
      "EllieIOSATS",
      "-destination",
      `platform=iOS Simulator,id=${simulatorID}`,
      "-parallel-testing-enabled",
      "NO",
      "-derivedDataPath",
      join(owned, "DerivedData"),
      "-resultBundlePath",
      resultBundle,
      `ELLIE_ATS_TEST_ORIGIN=${origin}`,
      `ELLIE_ATS_TEST_PIN=${pin}`,
      "CODE_SIGNING_ALLOWED=YES",
      "test",
    ],
    { timeout: 600_000 },
  );
  if (acceptedRequests !== 1 || unexpectedRequests !== 0) {
    throw new Error("The fixture did not receive exactly one valid native request.");
  }
  const appInfo = JSON.parse(
    await execute(
      "plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        join(owned, "DerivedData/Build/Products/Debug-iphonesimulator/Ellie.app/Info.plist"),
      ],
      { capture: true },
    ),
  );
  const policy = appInfo.NSAppTransportSecurity;
  if (
    JSON.stringify(policy) !== JSON.stringify({ NSAllowsLocalNetworking: true }) ||
    "EllieATSTestOrigin" in appInfo ||
    "EllieATSTestPin" in appInfo
  ) {
    throw new Error(
      "Built app transport policy or test isolation differs from the expected configuration.",
    );
  }
  succeeded = true;
  console.log("iOS app-hosted pinned HTTPS, rejection, Keychain and built-policy checks passed.");
} finally {
  if (server) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
  if (simulatorID) {
    for (const action of ["shutdown", "delete"]) {
      try {
        await execute("xcrun", ["simctl", action, simulatorID], { timeout: 15_000, cleanup: true });
      } catch {
        console.warn(`The owned iOS simulator could not complete ${action}: ${simulatorID}`);
      }
    }
  }
  rmSync(owned, { recursive: true, force: true });
  if (succeeded) rmSync(resultBundle, { recursive: true, force: true });
}

if (requestedSignal)
  process.exitCode =
    128 + (requestedSignal === "SIGINT" ? 2 : requestedSignal === "SIGTERM" ? 15 : 1);
