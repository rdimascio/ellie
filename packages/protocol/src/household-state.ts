export const HOUSEHOLD_CONTRACT = {
  version: 1,
  maximumAuthorities: 128,
  maximumDocuments: 256,
  maximumDashboardBytes: 128 * 1024,
  maximumChoresBytes: 256 * 1024,
  maximumAuthorityFileBytes: 1024 * 1024,
  maximumDocumentFileBytes: 32 * 1024 * 1024,
  maximumSafeRevision: Number.MAX_SAFE_INTEGER,
} as const;

export type HouseholdProfile = "shared" | "private";
export type HouseholdKind = "dashboards" | "chores";
export type HouseholdAccess = "read" | "write";
export interface HouseholdGrant {
  clientId: string;
  profile: HouseholdProfile;
  kind: HouseholdKind;
  access: HouseholdAccess;
}

const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid household document.");
  return value as Record<string, unknown>;
};
const swiftBoundaryWhitespace =
  // Match Foundation's whitespace/newline set, including its intentional C0 ranges.
  // eslint-disable-next-line no-control-regex
  /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
const hasLoneSurrogate = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });
const text = (value: unknown, maximum: number, empty = false): string => {
  if (
    typeof value !== "string" ||
    (!empty && !value) ||
    value.length > maximum ||
    swiftBoundaryWhitespace.test(value) ||
    hasLoneSurrogate(value)
  )
    throw new Error("Invalid household document.");
  return value;
};
const id = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !/[A-Za-z0-9]/.test(value[0]!) ||
    [...value].some((character) => !/[A-Za-z0-9_-]/.test(character))
  )
    throw new Error("Invalid household identifier.");
  return value;
};
const clientId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    !/[A-Za-z0-9]/.test(value[0]!) ||
    [...value].some((character) => !/[A-Za-z0-9._-]/.test(character))
  )
    throw new Error("Invalid household grant.");
  return value;
};
export const householdProfile = (value: unknown): HouseholdProfile => {
  if (value !== "shared" && value !== "private") throw new Error("Invalid household profile.");
  return value;
};
export const householdKind = (value: unknown): HouseholdKind => {
  if (value !== "dashboards" && value !== "chores")
    throw new Error("Invalid household document kind.");
  return value;
};
export const householdAccess = (value: unknown): HouseholdAccess => {
  if (value !== "read" && value !== "write") throw new Error("Invalid household access.");
  return value;
};
export function householdGrant(value: unknown): HouseholdGrant {
  const row = object(value);
  if (!exact(row, ["clientId", "profile", "kind", "access"]))
    throw new Error("Invalid household grant.");
  return {
    clientId: clientId(row.clientId),
    profile: householdProfile(row.profile),
    kind: householdKind(row.kind),
    access: householdAccess(row.access),
  };
}

const uuid = (value: unknown) => {
  const result = text(value, 64);
  if (!/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(result))
    throw new Error("Invalid household document.");
  return result;
};
const day = (value: unknown) => {
  if (
    typeof value !== "string" ||
    value.length !== 10 ||
    value.startsWith("0000-") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  )
    throw new Error("Invalid household document.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error("Invalid household document.");
  return value;
};
const timeZone = (value: unknown): string => {
  const result = text(value, 100);
  if (/^[+-]/.test(result)) throw new Error("Invalid household document.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: result });
  } catch {
    const fixedGMT = /^GMT[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])$/.test(result);
    if (!fixedGMT) throw new Error("Invalid household document.");
  }
  return result;
};
const hasDisallowedBodyControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 32 && ![10, 11, 12, 13].includes(code)) ||
      (code >= 127 && code <= 159 && code !== 133)
    );
  });
const playlistID = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < 13 ||
    value.length > 80 ||
    !value.startsWith("PL") ||
    [...value].some((character) => !/[A-Za-z0-9_-]/.test(character))
  )
    throw new Error("Invalid dashboard document.");
  return value;
};
const widgetConfig = (kind: string, value: unknown): void => {
  const config = object(value);
  const keys = Object.keys(config);
  if (kind === "clock") {
    if (!keys.every((key) => key === "timeZone") || keys.length > 1)
      throw new Error("Invalid dashboard document.");
    if ("timeZone" in config) timeZone(config.timeZone);
    return;
  }
  if (kind === "note") {
    if (!keys.every((key) => key === "text") || keys.length > 1)
      throw new Error("Invalid dashboard document.");
    if (
      "text" in config &&
      (typeof config.text !== "string" ||
        config.text.length > 2_000 ||
        hasLoneSurrogate(config.text))
    )
      throw new Error("Invalid dashboard document.");
    return;
  }
  if (kind === "playlist") {
    if (!keys.every((key) => key === "youtubePlaylistID") || keys.length > 1)
      throw new Error("Invalid dashboard document.");
    if ("youtubePlaylistID" in config) playlistID(config.youtubePlaylistID);
    return;
  }
  if (keys.length !== 0) throw new Error("Invalid dashboard document.");
};
export function householdDocument(kind: HouseholdKind, value: unknown): unknown {
  const state = object(value);
  if (kind === "dashboards") {
    if (
      !exact(state, ["version", "dashboards"]) ||
      state.version !== 1 ||
      !Array.isArray(state.dashboards) ||
      state.dashboards.length > 12
    )
      throw new Error("Invalid dashboard document.");
    const ids = new Set<string>();
    for (const raw of state.dashboards) {
      const board = object(raw);
      if (
        !exact(board, ["id", "name", "widgets"]) ||
        !Array.isArray(board.widgets) ||
        board.widgets.length > 24
      )
        throw new Error("Invalid dashboard document.");
      const boardId = id(board.id);
      if (ids.has(boardId)) throw new Error("Invalid dashboard document.");
      ids.add(boardId);
      text(board.name, 80);
      const widgets = new Set<string>();
      for (const item of board.widgets) {
        const widget = object(item);
        if (!exact(widget, ["id", "type", "title", "size", "config"]))
          throw new Error("Invalid dashboard document.");
        const widgetId = id(widget.id);
        if (widgets.has(widgetId)) throw new Error("Invalid dashboard document.");
        widgets.add(widgetId);
        if (
          typeof widget.type !== "string" ||
          !["clock", "note", "weather", "calendar", "chores", "playlist"].includes(widget.type) ||
          typeof widget.size !== "string" ||
          !["small", "wide"].includes(widget.size)
        )
          throw new Error("Invalid dashboard document.");
        text(widget.title, 80);
        widgetConfig(widget.type, widget.config);
      }
    }
  } else {
    if (
      !exact(state, ["version", "householdTimeZone", "chores"]) ||
      state.version !== 1 ||
      !Array.isArray(state.chores) ||
      state.chores.length > 500
    )
      throw new Error("Invalid chores document.");
    timeZone(state.householdTimeZone);
    const ids = new Set<string>();
    for (const raw of state.chores) {
      const chore = object(raw);
      const choreKeys = Object.keys(chore);
      if (
        !["id", "title", "member", "body", "dueDay"].every((key) => key in chore) ||
        !choreKeys.every((key) =>
          ["id", "title", "member", "body", "dueDay", "completedDay"].includes(key),
        )
      )
        throw new Error("Invalid chores document.");
      const choreId = uuid(chore.id);
      if (ids.has(choreId)) throw new Error("Invalid chores document.");
      ids.add(choreId);
      const choreTitle = text(chore.title, 120);
      const choreMember = text(chore.member, 60);
      if (/[\p{Cc}\p{Cf}]/u.test(choreTitle) || /[\p{Cc}\p{Cf}]/u.test(choreMember))
        throw new Error("Invalid chores document.");
      if (
        typeof chore.body !== "string" ||
        chore.body.length > 500 ||
        swiftBoundaryWhitespace.test(chore.body) ||
        /\p{Cf}/u.test(chore.body) ||
        hasLoneSurrogate(chore.body) ||
        hasDisallowedBodyControl(chore.body)
      )
        throw new Error("Invalid chores document.");
      day(chore.dueDay);
      if (chore.completedDay !== undefined && chore.completedDay !== null) day(chore.completedDay);
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
  if (
    bytes >
    (kind === "dashboards"
      ? HOUSEHOLD_CONTRACT.maximumDashboardBytes
      : HOUSEHOLD_CONTRACT.maximumChoresBytes)
  )
    throw new Error("Household document too large.");
  return structuredClone(state);
}

export const emptyHouseholdDocument = (kind: HouseholdKind): unknown =>
  kind === "dashboards"
    ? { version: 1, dashboards: [] }
    : { version: 1, householdTimeZone: "UTC", chores: [] };
