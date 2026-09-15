import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";

export const BROWSER_OPERATION_REGISTRY_MAXIMUM_BYTES = 32 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SHA = /^[a-f0-9]{64}$/;
const operations = ["read", "scroll", "search", "select", "playback"] as const;
export type ReviewedBrowserOperation = (typeof operations)[number];
export type ReviewedBrowserBinding = {
  id: string;
  origin: string;
  operation: ReviewedBrowserOperation;
  toolName: string;
  inputSchemaSha256: string;
  /** Exact reviewed tool response admitting a reported completion; it does not observe page state. */
  successValueSha256?: string;
  argumentKey?: string;
};
export type ReviewedBrowserRegistry = { version: 1; bindings: ReviewedBrowserBinding[] };

const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error("Invalid reviewed browser registry.");
};
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !ID.test(value))
    throw new Error("Invalid reviewed browser registry.");
  return value;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Invalid reviewed browser registry.");
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

export function reviewedBrowserRegistry(value: unknown): ReviewedBrowserRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid reviewed browser registry.");
  const root = value as Record<string, unknown>;
  exact(root, ["version", "bindings"]);
  if (root.version !== 1 || !Array.isArray(root.bindings) || root.bindings.length > 32)
    throw new Error("Invalid reviewed browser registry.");
  const bindings = root.bindings.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid reviewed browser registry.");
    const item = raw as Record<string, unknown>;
    const operation = item.operation as ReviewedBrowserOperation;
    const needsArgument = operation !== "read";
    exact(
      item,
      needsArgument
        ? [
            "id",
            "origin",
            "operation",
            "toolName",
            "inputSchemaSha256",
            "successValueSha256",
            "argumentKey",
          ]
        : ["id", "origin", "operation", "toolName", "inputSchemaSha256"],
    );
    let origin: URL;
    try {
      origin = new URL(String(item.origin));
    } catch {
      throw new Error("Invalid reviewed browser registry.");
    }
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== item.origin ||
      !operations.includes(operation) ||
      typeof item.toolName !== "string" ||
      item.toolName.length < 1 ||
      item.toolName.length > 100 ||
      /\p{C}/u.test(item.toolName) ||
      typeof item.inputSchemaSha256 !== "string" ||
      !SHA.test(item.inputSchemaSha256)
    )
      throw new Error("Invalid reviewed browser registry.");
    const binding: ReviewedBrowserBinding = {
      id: identifier(item.id),
      origin: origin.origin,
      operation,
      toolName: item.toolName,
      inputSchemaSha256: item.inputSchemaSha256,
      ...(needsArgument ? { argumentKey: identifier(item.argumentKey) } : {}),
      ...(needsArgument && typeof item.successValueSha256 === "string"
        ? { successValueSha256: item.successValueSha256 }
        : {}),
    };
    if (
      operation !== "read" &&
      (binding.id !== operation || !SHA.test(binding.successValueSha256 ?? ""))
    )
      throw new Error("Invalid reviewed browser registry.");
    return binding;
  });
  const keys = bindings.map((item) => `${item.origin}\0${item.operation}\0${item.id}`);
  if (new Set(keys).size !== keys.length) throw new Error("Invalid reviewed browser registry.");
  return { version: 1, bindings };
}

export function canonicalReviewedBrowserRegistry(value: ReviewedBrowserRegistry): Buffer {
  return Buffer.from(canonical(value) + "\n");
}

export function loadReviewedBrowserRegistry(
  path: string,
  testHooks: { beforeFinalValidation?(): void } = {},
): ReviewedBrowserRegistry {
  if (!path.startsWith("/") || path.includes("\0"))
    throw new Error("Invalid reviewed browser registry path.");
  const parent = lstatSync(dirname(path), { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== BigInt(process.getuid?.() ?? -1) ||
    (parent.mode & 0o777n) !== 0o700n
  )
    throw new Error("Reviewed browser registry directory is not private.");
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 1n ||
      before.size > BigInt(BROWSER_OPERATION_REGISTRY_MAXIMUM_BYTES)
    )
      throw new Error("Reviewed browser registry is not a private regular file.");
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(descriptor, data, offset, data.length - offset, null);
      if (count <= 0) throw new Error("Reviewed browser registry changed while reading.");
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new Error("Reviewed browser registry changed while reading.");
    const after = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    for (const current of [after, named]) {
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.uid !== before.uid ||
        current.mode !== before.mode ||
        current.nlink !== before.nlink ||
        current.size !== before.size ||
        current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs
      )
        throw new Error("Reviewed browser registry changed while reading.");
    }
    const parsed = reviewedBrowserRegistry(JSON.parse(data.toString("utf8")));
    if (!canonicalReviewedBrowserRegistry(parsed).equals(data))
      throw new Error("Reviewed browser registry is not canonical.");
    testHooks.beforeFinalValidation?.();
    const finalParent = lstatSync(dirname(path), { bigint: true });
    if (
      finalParent.dev !== parent.dev ||
      finalParent.ino !== parent.ino ||
      finalParent.uid !== parent.uid ||
      finalParent.mode !== parent.mode ||
      finalParent.nlink !== parent.nlink ||
      finalParent.mtimeNs !== parent.mtimeNs ||
      finalParent.ctimeNs !== parent.ctimeNs
    )
      throw new Error("Reviewed browser registry directory changed while reading.");
    const finalNamed = lstatSync(path, { bigint: true });
    if (
      finalNamed.dev !== before.dev ||
      finalNamed.ino !== before.ino ||
      finalNamed.uid !== before.uid ||
      finalNamed.mode !== before.mode ||
      finalNamed.nlink !== before.nlink ||
      finalNamed.size !== before.size ||
      finalNamed.mtimeNs !== before.mtimeNs ||
      finalNamed.ctimeNs !== before.ctimeNs
    )
      throw new Error("Reviewed browser registry changed while reading.");
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}
