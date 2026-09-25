const targets = new Set(["watch-fixture-mac-a", "watch-fixture-mac-b"]);
const operations = new Set(["refresh", "read", "play", "pause"]);

export function requireReadUnknownEvents(value, target) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8_192 || !targets.has(target)) {
    throw new Error("Invalid paired read-unknown event evidence.");
  }
  const lines = value.trim().split("\n");
  const rows = lines.map((line) => JSON.parse(line));
  if (
    rows.length !== 2 ||
    rows.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "operation,target" ||
        !operations.has(row.operation) ||
        row.target !== target,
    )
  ) {
    throw new Error("Paired read-unknown evidence contained an unexpected event.");
  }
  const counts = Object.fromEntries(
    [...operations].map((operation) => [
      operation,
      rows.filter((row) => row.operation === operation).length,
    ]),
  );
  if (counts.refresh !== 1 || counts.read !== 1 || counts.play !== 0 || counts.pause !== 0) {
    throw new Error(
      "Paired read-unknown event counts were not exactly one read and zero mutations.",
    );
  }
  return counts;
}
