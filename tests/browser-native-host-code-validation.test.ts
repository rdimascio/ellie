import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

test(
  "production native-host code validation accepts its signed audit-token peer and rejects a different executable",
  { skip: process.platform !== "darwin", timeout: 125_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "ellie-native-host-code-"));
    let retainScratch = false;
    try {
      const accessibility = join(repository, "packages/macos/native/BrowserAccessibility.swift");
      const broker = join(repository, "packages/macos/native/BrowserRuntimeBroker.swift");
      const fixture = join(repository, "tests/fixtures/browser-native-host-code-probe.swift");
      const embeddedBroker = join(scratch, "EmbeddedBrowserRuntimeBroker.swift");
      const executable = join(scratch, "browser-native-host-code-probe");
      writeFileSync(
        embeddedBroker,
        `${readFileSync(broker, "utf8")}\n${readFileSync(fixture, "utf8")}`,
        { mode: 0o600 },
      );
      execFileSync(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-j",
          "2",
          "-swift-version",
          "5",
          "-O",
          "-parse-as-library",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
          "-D",
          "ELLIE_BROWSER_RUNTIME_BROKER_EMBEDDED_TEST",
          accessibility,
          embeddedBroker,
          "-lbsm",
          "-o",
          executable,
        ],
        { stdio: "pipe", timeout: 90_000 },
      );
      const output = JSON.parse(
        execFileSync(executable, [process.execPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 20_000,
        }),
      );
      assert.equal(output.wrongExecutableRejected, true);
      assert.equal(output.peerPidMatchesAudit, true);
      assert.ok(output.hashBytes === 20 || output.hashBytes === 32);
    } catch (error) {
      const failure = error as Error & {
        code?: string | number;
        signal?: string;
        stderr?: Buffer | string;
      };
      const stderr = String(failure.stderr ?? "");
      if (failure.code === "ETIMEDOUT" || failure.signal || stderr.includes("cleanup_uncertain")) {
        retainScratch = true;
        failure.message += `; retained uncertain fixture at ${scratch}`;
      }
      throw failure;
    } finally {
      if (!retainScratch) rmSync(scratch, { recursive: true, force: true });
    }
  },
);
