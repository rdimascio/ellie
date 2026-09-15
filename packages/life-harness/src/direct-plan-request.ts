const PLAN_IMPERATIVE =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:(?:create|make|start|add)\s+(?:a\s+)?(?:plan|checklist)\b|help\s+me\s+(?:plan|prepare)\b|(?:plan|prepare)\s+(?:for\s+)?\b)/i;
const REPORTED =
  /(?:\b(?:said|asked|told|wrote|quoted)(?:\s+(?:this|the following|as follows))?\b|\b(?:the instruction was written as follows|for example|example|quote)\s*:?)\s*$/i;
const WITHDRAWN =
  /\b(?:do\s+not|don't|don’t|never)\s+(?:(?:make|create|start|add)\s+(?:an?\s+)?(?:plan|checklist)|save\s+(?:(?:an?\s+|any\s+)?(?:plan|checklist)|it|this|that|anything))\b/i;

function masked(value: string): string {
  value = value.replace(/^\s*>.*$/gm, (line) => " ".repeat(line.length));
  let result = "";
  let quote: '"' | "“" | "'" | "`" | undefined;
  let fenced = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("```", index)) {
      fenced = !fenced;
      result += "   ";
      index += 2;
      continue;
    }
    const character = value[index]!;
    if (!fenced) {
      if (!quote && character === '"') quote = '"';
      else if (!quote && character === "“") quote = "“";
      else if (
        !quote &&
        character === "'" &&
        !(
          /[\p{L}\p{N}]/u.test(value[index - 1] ?? "") &&
          /[\p{L}\p{N}]/u.test(value[index + 1] ?? "")
        )
      )
        quote = "'";
      else if (!quote && character === "`") quote = "`";
      else if (
        quote &&
        ((quote === "“" && character === "”") || (quote !== "“" && character === quote))
      )
        quote = undefined;
    }
    result += fenced || quote || ['"', "”"].includes(character) ? " " : character;
  }
  return result;
}

/** Classifies only an imperative in the current message; it never grants authority itself. */
export function isDirectPlanRequest(message: string): boolean {
  const value = masked(message.trim());
  if (WITHDRAWN.test(value)) return false;
  const boundaries = [0];
  for (const match of value.matchAll(/[.!?]\s+/g)) boundaries.push(match.index + match[0].length);
  return boundaries.some((start) => {
    const prefix = value.slice(0, start).trimEnd();
    if (prefix && REPORTED.test(prefix.replace(/[.!?]\s*$/, ""))) return false;
    const segment = value.slice(start).trimStart();
    return (
      PLAN_IMPERATIVE.test(segment) && !/^(?:please\s+)?(?:do\s+not|don't|never)\b/i.test(segment)
    );
  });
}
