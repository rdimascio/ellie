import { createHash } from "node:crypto";
import type {
  LifeActor,
  LifeRecord,
  LifeRecordKind,
  LifeScope,
  LifeStore,
} from "../../life-core/src/index.ts";

export type LifeImportFormat = "ics" | "vcard";
export interface ImportItem {
  key: string;
  kind: Extract<LifeRecordKind, "event" | "holiday" | "contact" | "birthday">;
  title: string;
  body?: string;
  data: Record<string, unknown>;
  relatedKeys: Array<{ type: string; targetKey: string }>;
  warnings: string[];
}
export interface ImportPreview {
  format: LifeImportFormat;
  source: { title: string; contentHash: string };
  items: ImportItem[];
  warnings: string[];
}
export interface PreviewLifeImportInput {
  format: LifeImportFormat;
  content: string;
  fileName?: string;
  defaultTimeZone?: string;
}
export interface CommitLifeImportInput extends PreviewLifeImportInput {
  store: LifeStore;
  actor: LifeActor;
  scope: LifeScope;
  selectedKeys?: string[];
  sourceId?: string;
}
export interface ImportCommitResult {
  source: LifeRecord;
  records: LifeRecord[];
  created: number;
  updated: number;
  unchanged: number;
  conflicts: Array<{ key: string; recordId: string; warning: string }>;
}

const MAX_CONTENT = 2_000_000,
  MAX_LINES = 20_000,
  MAX_ITEMS = 2_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bounded = (value: unknown, max: number, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new TypeError(`${label} is invalid.`);
  return value.trim();
};
const decode = (value: string) =>
  value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .slice(0, 100_000);
const stableKey = (format: LifeImportFormat, uid: string | undefined, fallback: string) =>
  `${format}:${hash(uid ? `uid:${uid}` : fallback).slice(0, 32)}`;

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}
function lines(content: string): string[] {
  if (
    typeof content !== "string" ||
    !content.trim() ||
    Buffer.byteLength(content) > MAX_CONTENT ||
    /\0/.test(content)
  )
    throw new TypeError("Import content is invalid or too large.");
  const physical = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (physical.length > MAX_LINES) throw new TypeError("Import has too many lines.");
  const unfolded: string[] = [];
  for (const line of physical) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length)
      unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  return unfolded;
}
function property(line: string): Property | undefined {
  const colon = line.indexOf(":");
  if (colon < 1 || line.length > 200_000) return undefined;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";"),
    params: Record<string, string> = {};
  for (const item of rawParams) {
    const at = item.indexOf("=");
    if (at > 0) params[item.slice(0, at).toUpperCase()] = item.slice(at + 1);
  }
  return { name: rawName!.toUpperCase(), params, value: line.slice(colon + 1) };
}
function components(content: string, component: "VEVENT" | "VCARD"): Property[][] {
  const output: Property[][] = [];
  let current: Property[] | undefined;
  for (const line of lines(content)) {
    if (line.toUpperCase() === `BEGIN:${component}`) {
      if (current) throw new TypeError("Nested import component is invalid.");
      current = [];
      continue;
    }
    if (line.toUpperCase() === `END:${component}`) {
      if (!current) throw new TypeError("Unbalanced import component.");
      output.push(current);
      current = undefined;
      if (output.length > MAX_ITEMS) throw new TypeError("Import has too many items.");
      continue;
    }
    if (current) {
      const parsed = property(line);
      if (parsed) current.push(parsed);
    }
  }
  if (current) throw new TypeError("Unclosed import component.");
  return output;
}
const first = (item: Property[], name: string) => item.find((entry) => entry.name === name);
function validZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
function zoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): number[] {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const wall = Date.UTC(year, month - 1, day, hour, minute, second),
    matches: number[] = [];
  for (const probe of [wall - 12 * 3_600_000, wall, wall + 12 * 3_600_000]) {
    const p = Object.fromEntries(
      format
        .formatToParts(new Date(probe))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    const candidate = wall - (represented - probe),
      c = Object.fromEntries(
        format
          .formatToParts(new Date(candidate))
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, Number(part.value)]),
      );
    if (
      c.year === year &&
      c.month === month &&
      c.day === day &&
      c.hour === hour &&
      c.minute === minute &&
      c.second === second
    )
      matches.push(candidate);
  }
  return [...new Set(matches)].sort((a, b) => a - b);
}
function parseDate(
  prop: Property | undefined,
  defaultZone: string | undefined,
  warnings: string[],
  label: string,
): Record<string, unknown> {
  if (!prop) return {};
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(prop.value);
  if (prop.params.VALUE === "DATE" || date) {
    if (
      !date ||
      new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])))
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "") !== prop.value
    ) {
      warnings.push(`${label} date is invalid.`);
      return {};
    }
    return {
      [`${label}Date`]: `${date[1]}-${date[2]}-${date[3]}`,
      allDay: true,
    };
  }
  const value = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(prop.value);
  if (!value) {
    warnings.push(`${label} time format is unsupported.`);
    return {};
  }
  const [year, month, day, hour, minute] = value.slice(1, 6).map(Number),
    second = Number(value[6] ?? 0);
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > 31 ||
    hour! > 23 ||
    minute! > 59 ||
    second > 59
  ) {
    warnings.push(`${label} time is invalid.`);
    return {};
  }
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day!) {
    warnings.push(`${label} date is invalid.`);
    return {};
  }
  if (value[7])
    return {
      [`${label}At`]: Date.UTC(year!, month! - 1, day!, hour!, minute!, second),
      timeZone: "UTC",
    };
  const zone = (prop.params.TZID ?? defaultZone)?.replace(/^"|"$/g, "");
  if (!zone) {
    warnings.push(`${label} is floating and no default time zone was supplied.`);
    return { [`${label}Local`]: prop.value };
  }
  if (!validZone(zone)) {
    warnings.push(`${label} uses unknown time zone ${zone}.`);
    return { [`${label}Local`]: prop.value, timeZone: zone };
  }
  const candidates = zoned(year!, month!, day!, hour!, minute!, second, zone);
  if (candidates.length === 0) {
    warnings.push(`${label} falls in a nonexistent local time in ${zone}.`);
    return { [`${label}Local`]: prop.value, timeZone: zone };
  }
  if (candidates.length > 1) {
    warnings.push(
      `${label} is ambiguous during a repeated local hour in ${zone}; no offset was guessed.`,
    );
    return { [`${label}Local`]: prop.value, timeZone: zone };
  }
  return { [`${label}At`]: candidates[0], timeZone: zone };
}

function previewICS(
  content: string,
  defaultTimeZone?: string,
): { items: ImportItem[]; warnings: string[] } {
  const warnings: string[] = [];
  if (defaultTimeZone && !validZone(defaultTimeZone))
    throw new TypeError("Default time zone is invalid.");
  const items = components(content, "VEVENT").map((event, index): ImportItem => {
    const itemWarnings: string[] = [],
      uid = first(event, "UID")?.value,
      title = decode(first(event, "SUMMARY")?.value ?? `Imported event ${index + 1}`);
    const start = parseDate(first(event, "DTSTART"), defaultTimeZone, itemWarnings, "start"),
      end = parseDate(first(event, "DTEND"), defaultTimeZone, itemWarnings, "end");
    if (!first(event, "DTSTART")) itemWarnings.push("Event has no start time.");
    if (first(event, "DURATION"))
      itemWarnings.push("DURATION is unsupported and was not used to infer an end time.");
    const startAllDay = "startDate" in start,
      endAllDay = "endDate" in end;
    if (Object.keys(end).length && startAllDay !== endAllDay)
      itemWarnings.push("Start and end use different date/time modes; the range needs review.");
    const startValue = (start.startAt ?? start.startDate) as number | string | undefined,
      endValue = (end.endAt ?? end.endDate) as number | string | undefined;
    if (startValue !== undefined && endValue !== undefined && endValue <= startValue)
      itemWarnings.push("Event end must be after its start.");
    const recurrence = first(event, "RRULE")?.value;
    if (recurrence)
      itemWarnings.push(
        "Recurrence is retained for review but is not expanded or scheduled automatically.",
      );
    if (event.some((prop) => prop.name === "EXDATE" || prop.name === "RDATE"))
      itemWarnings.push("Recurrence exceptions are retained but not expanded.");
    const recurrenceId = first(event, "RECURRENCE-ID")?.value;
    if (recurrenceId)
      itemWarnings.push("This recurring-event exception is imported as a distinct review item.");
    if (event.some((prop) => prop.name === "BEGIN" && prop.value.toUpperCase() === "VALARM"))
      itemWarnings.push("Embedded alarms are ignored and never scheduled automatically.");
    const categories = (first(event, "CATEGORIES")?.value ?? "").toLowerCase();
    return {
      key: stableKey(
        "ics",
        uid ? `${uid}${recurrenceId ? `:instance:${recurrenceId}` : ""}` : undefined,
        event.map((p) => `${p.name}:${p.value}`).join("\n"),
      ),
      kind: categories.includes("holiday") ? "holiday" : "event",
      title: bounded(title, 2_000, "Event title"),
      ...(first(event, "DESCRIPTION") ? { body: decode(first(event, "DESCRIPTION")!.value) } : {}),
      data: {
        ...start,
        ...end,
        ...(uid ? { uid: uid.slice(0, 500) } : {}),
        ...(recurrence ? { recurrence: recurrence.slice(0, 2_000) } : {}),
        ...(recurrenceId ? { recurrenceId: recurrenceId.slice(0, 500) } : {}),
        ...(first(event, "STATUS")?.value.toUpperCase() === "CANCELLED" ? { cancelled: true } : {}),
        importFingerprint: hash(
          event.map((p) => `${p.name};${JSON.stringify(p.params)}:${p.value}`).join("\n"),
        ),
      },
      relatedKeys: [],
      warnings: itemWarnings,
    };
  });
  if (!items.length) warnings.push("No VEVENT components were found.");
  return { items, warnings };
}

function birthday(
  value: string,
  warnings: string[],
): { month: number; day: number; birthYear?: number } | undefined {
  const match = /^(?:(\d{4})-?)?(\d{2})-?(\d{2})$/.exec(value.replace(/^--/, ""));
  if (!match) {
    warnings.push("Birthday format is unsupported.");
    return undefined;
  }
  const year = match[1] ? Number(match[1]) : undefined,
    month = Number(match[2]),
    day = Number(match[3]);
  const validationYear = year ?? 2024,
    date = new Date(Date.UTC(validationYear, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    warnings.push("Birthday date is invalid.");
    return undefined;
  }
  return { month, day, ...(year === undefined ? {} : { birthYear: year }) };
}
function previewVCard(content: string): {
  items: ImportItem[];
  warnings: string[];
} {
  const warnings: string[] = [],
    items: ImportItem[] = [];
  for (const [index, card] of components(content, "VCARD").entries()) {
    const itemWarnings: string[] = [],
      uid = first(card, "UID")?.value,
      name = decode(first(card, "FN")?.value ?? `Imported contact ${index + 1}`);
    if (card.some((entry) => entry.params.ENCODING))
      itemWarnings.push("Encoded vCard fields are unsupported and were not decoded.");
    const contactKey = stableKey("vcard", uid, card.map((p) => `${p.name}:${p.value}`).join("\n"));
    const data: Record<string, unknown> = {
      importFingerprint: hash(
        card.map((p) => `${p.name};${JSON.stringify(p.params)}:${p.value}`).join("\n"),
      ),
    };
    const email = first(card, "EMAIL")?.value,
      phone = first(card, "TEL")?.value;
    if (email) data.email = email.slice(0, 500);
    if (phone) data.phone = phone.slice(0, 200);
    items.push({
      key: contactKey,
      kind: "contact",
      title: bounded(name, 2_000, "Contact name"),
      data,
      relatedKeys: [],
      warnings: itemWarnings,
    });
    const bday = first(card, "BDAY");
    if (bday) {
      const parsed = birthday(bday.value, itemWarnings);
      if (parsed)
        items.push({
          key: `${contactKey}:birthday`,
          kind: "birthday",
          title: `${name}'s birthday`,
          data: {
            ...parsed,
            importFingerprint: hash(`birthday:${bday.value}`),
          },
          relatedKeys: [{ type: "person", targetKey: contactKey }],
          warnings: [...itemWarnings],
        });
    }
  }
  if (!items.length) warnings.push("No VCARD components were found.");
  return { items, warnings };
}

export function previewLifeImport(input: PreviewLifeImportInput): ImportPreview {
  if (input.format !== "ics" && input.format !== "vcard")
    throw new TypeError("Import format is unsupported.");
  const content = bounded(input.content, MAX_CONTENT, "Import content"),
    parsed =
      input.format === "ics" ? previewICS(content, input.defaultTimeZone) : previewVCard(content);
  const seen = new Set<string>();
  for (const item of parsed.items) {
    if (seen.has(item.key))
      item.warnings.push("Duplicate UID in this file; select only one conflicting item.");
    seen.add(item.key);
  }
  return {
    format: input.format,
    source: {
      title: input.fileName
        ? bounded(input.fileName, 500, "File name")
        : input.format === "ics"
          ? "Imported calendar"
          : "Imported contacts",
      contentHash: hash(content),
    },
    items: parsed.items,
    warnings: parsed.warnings,
  };
}

/** Commit reparses the original content. It never accepts preview items as authority. */
export function commitLifeImport(input: CommitLifeImportInput): ImportCommitResult {
  const content = bounded(input.content, MAX_CONTENT, "Import content"),
    preview = previewLifeImport({ ...input, content }),
    selected = input.selectedKeys ? new Set(input.selectedKeys) : undefined;
  if (
    selected &&
    (selected.size > MAX_ITEMS ||
      [...selected].some((key) => typeof key !== "string" || key.length > 200))
  )
    throw new TypeError("Import selection is invalid.");
  if (selected) {
    const counts = new Map<string, number>();
    for (const item of preview.items) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
    for (const key of selected) {
      if (!counts.has(key)) throw new TypeError(`Selected import key is not present: ${key}`);
      if (counts.get(key) !== 1) throw new TypeError(`Selected import key is ambiguous: ${key}`);
    }
  }
  const items = preview.items.filter((item) => !selected || selected.has(item.key));
  return input.store.commitImport(input.actor, {
    scope: input.scope,
    format: input.format,
    content,
    sourceTitle: preview.source.title,
    contentHash: preview.source.contentHash,
    sourceId: input.sourceId,
    items,
  });
}
