import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_NODES = 50_000;
const MAX_MESSAGE = 4_000;

export function failureReport(tree) {
  const failures = [];
  const pending = (Array.isArray(tree?.testNodes) ? tree.testNodes : []).map((node) => ({
    node,
    testCase: undefined,
  }));
  let visited = 0;
  while (pending.length && ++visited <= MAX_NODES) {
    const { node, testCase } = pending.pop();
    if (!node || typeof node !== "object") continue;
    const owner = node.nodeType === "Test Case" ? node : testCase;
    if (node.nodeType === "Failure Message" && typeof node.name === "string")
      failures.push({
        test: owner?.nodeIdentifier ?? owner?.name ?? "(unknown test)",
        message: node.name.slice(0, MAX_MESSAGE),
      });
    if (Array.isArray(node.children))
      for (const child of node.children) pending.push({ node: child, testCase: owner });
  }
  return failures.reverse();
}

const escapeData = (value) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value) => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

export function annotation({ test, message }) {
  return `::error title=${escapeProperty(test)}::${escapeData(message)}`;
}

function report(bundle) {
  if (!existsSync(bundle)) {
    console.log(`No result bundle at ${bundle}.`);
    return;
  }
  let tree;
  try {
    tree = JSON.parse(
      execFileSync(
        "xcrun",
        ["xcresulttool", "get", "test-results", "tests", "--path", bundle, "--format", "json"],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      ),
    );
  } catch (error) {
    console.log(`Could not read ${bundle}: ${error.message}`);
    return;
  }
  const failures = failureReport(tree);
  console.log(`${failures.length} failure message(s) in ${bundle}:`);
  for (const failure of failures) console.log(annotation(failure));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const bundle of process.argv.slice(2)) report(resolve(bundle));
}
