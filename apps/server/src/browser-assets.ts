import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import type { BrowserAssets } from "./browser-server.ts";

const DEFAULT_BUILD = fileURLToPath(new URL("../../command-center/dist/", import.meta.url));
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_ASSETS = 32;
const decoder = new TextDecoder("utf-8", { fatal: true });
const types: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  woff2: "font/woff2",
};

async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !safeOwner(stat)) throw new Error();
}

function safeOwner(stat: Stats): boolean {
  return (
    (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0
  );
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const [stat, named] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maximum ||
      !safeOwner(stat) ||
      stat.dev !== named.dev ||
      stat.ino !== named.ino
    )
      throw new Error();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const final = await handle.stat();
    if (
      length > maximum ||
      !safeOwner(final) ||
      final.nlink !== 1 ||
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs
    )
      throw new Error();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function list(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_ASSETS ||
    value.some((item) => typeof item !== "string")
  )
    throw new Error();
  return value as string[];
}

/** Loads only the built pairing entry and its manifest dependencies, never arbitrary paths. */
export async function loadBrowserAssets(build = DEFAULT_BUILD): Promise<BrowserAssets> {
  try {
    await directory(build);
    await directory(join(build, ".vite"));
    await directory(join(build, "pair"));
    await directory(join(build, "assets"));
    const manifest = object(
      JSON.parse(decoder.decode(await boundedFile(join(build, ".vite/manifest.json"), 64 * 1024))),
    );
    const entry = object(manifest["pair/index.html"]);
    if (entry.isEntry !== true) throw new Error();
    const names = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visited.has(key)) return;
      if (visited.size >= MAX_ASSETS || !Object.hasOwn(manifest, key)) throw new Error();
      visited.add(key);
      const item = object(manifest[key]);
      if (typeof item.file !== "string") throw new Error();
      for (const name of [item.file, ...list(item.css), ...list(item.assets)]) {
        if (!/^assets\/[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(name)) throw new Error();
        names.add(name);
      }
      for (const imported of [...list(item.imports), ...list(item.dynamicImports)]) visit(imported);
    };
    visit("pair/index.html");
    if (names.size > MAX_ASSETS) throw new Error();
    const html = await boundedFile(join(build, "pair/index.html"), 64 * 1024);
    const assets = new Map<string, { contentType: string; body: Buffer }>([
      ["/", { contentType: "text/html; charset=utf-8", body: html }],
    ]);
    let total = html.length;
    for (const name of names) {
      const contentType = types[name.split(".").at(-1)!];
      if (!contentType) throw new Error();
      const body = await boundedFile(join(build, name), MAX_FILE);
      total += body.length;
      if (total > MAX_TOTAL) throw new Error();
      assets.set(`/${name}`, { contentType, body });
    }
    return assets;
  } catch {
    throw new Error(
      "Pairing page is unavailable. Run bun run demo:build and restart the coordinator.",
    );
  }
}
