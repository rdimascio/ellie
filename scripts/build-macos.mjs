import { mkdir, rename, chmod, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
if (process.platform !== "darwin")
  throw new Error("Build the native helper on macOS with Xcode Command Line Tools installed.");
const root = join(homedir(), ".ellie");
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await lstat(root)).isSymbolicLink()) throw new Error("Private state cannot be a symlink.");
await chmod(root, 0o700);
const bin = join(root, "bin");
await mkdir(bin, { recursive: true, mode: 0o700 });
if ((await lstat(bin)).isSymbolicLink()) throw new Error("Helper directory cannot be a symlink.");
const output = join(bin, "ellie-macos.next");
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-parse-as-library",
    "packages/macos/native/Geometry.swift",
    "packages/macos/native/EllieHelper.swift",
    "-o",
    output,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "--identifier", "org.ellie.helper", output],
  { stdio: "inherit" },
);
await rename(output, join(bin, "ellie-macos"));
console.log("Native helper installed. Run bun run ellie doctor to check Accessibility.");
