import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Script } from "node:vm";

export type PluginKind = "arcade" | "mlb" | "custom";
export type PluginCapability = "storage" | "mlb.read";
export interface PluginManifest {
  name: string;
  description: string;
  kind: PluginKind;
  capabilities: PluginCapability[];
  html?: string;
}
export interface LifePlugin extends PluginManifest {
  id: string;
  owner: string;
  version: number;
  status: "ready";
  createdAt: number;
  updatedAt: number;
}
export interface PluginRevision {
  version: number;
  name: string;
  description: string;
  kind: PluginKind;
  capabilities: PluginCapability[];
  active: boolean;
}
export class PluginError extends Error {
  readonly code: "invalid" | "forbidden" | "not_found" | "conflict" | "unavailable";
  constructor(code: PluginError["code"]) {
    super(`Plugin ${code.replaceAll("_", " ")}.`);
    this.code = code;
  }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,511}$/.test(value))
    throw new PluginError("invalid");
  return value;
}
function ownerScope(value: string): string {
  if (!/^(user|group):[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value))
    throw new PluginError("invalid");
  return value;
}
/** Encoded identities keep a user ID containing ':' distinct from another user's storage key. */
export function groupStoragePrefix(userId: string): string {
  ownerScope(`user:${identifier(userId)}`);
  return `user64:${Buffer.from(userId, "utf8").toString("base64url")}:`;
}
export function groupStorageKey(userId: string, key: string): string {
  return identifier(`${groupStoragePrefix(userId)}${identifier(key)}`);
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new PluginError("invalid");
  return value.trim();
}
export function validateCustomHTML(input: unknown): string {
  const html = bounded(input, 160_000);
  // Compile classic inline scripts to catch broken candidates; never execute them here.
  // Runtime authority is enforced by HTTP CSP and the opaque iframe sandbox.
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1]!;
    if (/\bsrc\s*=|\btype\s*=\s*["']?module\b/i.test(attributes)) throw new PluginError("invalid");
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (type && !["text/javascript", "application/javascript"].includes(type.toLowerCase()))
      continue;
    try {
      new Script(match[2]!, { filename: "ellie-plugin-candidate.js" });
    } catch {
      throw new PluginError("invalid");
    }
  }
  return html;
}
export function validateManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginError("invalid");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !["name", "description", "kind", "capabilities", "html"].includes(key),
    )
  )
    throw new PluginError("invalid");
  if (!["arcade", "mlb", "custom"].includes(String(item.kind))) throw new PluginError("invalid");
  if (
    !Array.isArray(item.capabilities) ||
    item.capabilities.length > 2 ||
    item.capabilities.some((capability) => capability !== "storage" && capability !== "mlb.read")
  )
    throw new PluginError("invalid");
  const capabilities = [...new Set(item.capabilities)] as PluginCapability[];
  const kind = item.kind as PluginKind;
  if (kind === "arcade" && !capabilities.includes("storage")) throw new PluginError("invalid");
  if (kind === "mlb" && !capabilities.includes("mlb.read")) throw new PluginError("invalid");
  if (kind !== "custom" && item.html !== undefined) throw new PluginError("invalid");
  return {
    name: bounded(item.name, 120),
    description: bounded(item.description, 1000),
    kind,
    capabilities,
    ...(kind === "custom" ? { html: validateCustomHTML(item.html) } : {}),
  };
}
function protect(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    (!directory && stat.nlink !== 1) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
  )
    throw new PluginError("unavailable");
}
function unpack(row: Record<string, unknown>): LifePlugin {
  return {
    ...validateManifest(JSON.parse(String(row.manifest))),
    id: String(row.id),
    owner: String(row.owner),
    version: Number(row.version),
    status: "ready",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Permission decisions are made by the authenticated host; plugins never get this store directly. */
export class PluginStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    protect(dirname(path), true);
    try {
      protect(path, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;",
      );
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 1) throw new PluginError("unavailable");
      if (version === 0)
        this.db.exec(`BEGIN;
        CREATE TABLE plugins(id TEXT PRIMARY KEY,owner TEXT NOT NULL,manifest TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE plugin_versions(plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,version INTEGER NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(plugin_id,version));
        CREATE TABLE plugin_storage(plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key));
        PRAGMA user_version=1; COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  list(owner: string): LifePlugin[] {
    return this.db
      .prepare("SELECT * FROM plugins WHERE owner=? ORDER BY created_at DESC")
      .all(ownerScope(owner))
      .map(unpack);
  }
  get(owner: string, id: string): LifePlugin {
    const row = this.db
      .prepare("SELECT * FROM plugins WHERE id=? AND owner=?")
      .get(identifier(id), ownerScope(owner));
    if (!row) throw new PluginError("not_found");
    return unpack(row);
  }
  /** Review retained revisions without copying generated programs into ordinary view refreshes. */
  history(owner: string, id: string): PluginRevision[] {
    const current = this.get(owner, id);
    return this.db
      .prepare(
        "SELECT version,manifest FROM plugin_versions WHERE plugin_id=? ORDER BY version DESC LIMIT 100",
      )
      .all(current.id)
      .map((row) => {
        const manifest = validateManifest(JSON.parse(String(row.manifest)));
        return {
          version: Number(row.version),
          name: manifest.name,
          description: manifest.description,
          kind: manifest.kind,
          capabilities: manifest.capabilities,
          active: Number(row.version) === current.version,
        };
      });
  }
  install(owner: string, input: PluginManifest): LifePlugin {
    ownerScope(owner);
    const manifest = validateManifest(input);
    if (this.list(owner).length >= 64) throw new PluginError("invalid");
    const id = randomUUID(),
      now = this.now(),
      json = JSON.stringify(manifest);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO plugins VALUES(?,?,?,?,?,?)").run(id, owner, json, 1, now, now);
      this.db.prepare("INSERT INTO plugin_versions VALUES(?,?,?)").run(id, 1, json);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(owner, id);
  }
  update(owner: string, id: string, expectedVersion: number, input: PluginManifest): LifePlugin {
    const previous = this.get(owner, id),
      manifest = validateManifest(input);
    if (previous.version !== expectedVersion) throw new PluginError("conflict");
    // Updates do not silently acquire new host capabilities or reinterpret stored data under another kind.
    if (
      manifest.kind !== previous.kind ||
      manifest.capabilities.some((item) => !previous.capabilities.includes(item))
    )
      throw new PluginError("forbidden");
    const version = previous.version + 1,
      json = JSON.stringify(manifest);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO plugin_versions VALUES(?,?,?)").run(id, version, json);
      const result = this.db
        .prepare("UPDATE plugins SET manifest=?,version=?,updated_at=? WHERE id=? AND version=?")
        .run(json, version, this.now(), id, expectedVersion);
      if (Number(result.changes) !== 1) throw new PluginError("conflict");
      this.db
        .prepare("DELETE FROM plugin_versions WHERE plugin_id=? AND version < ?")
        .run(id, version - 99);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(owner, id);
  }
  rollback(owner: string, id: string, expectedVersion: number, targetVersion: number): LifePlugin {
    this.get(owner, id);
    const row = this.db
      .prepare("SELECT manifest FROM plugin_versions WHERE plugin_id=? AND version=?")
      .get(id, targetVersion);
    if (!row) throw new PluginError("not_found");
    return this.update(
      owner,
      id,
      expectedVersion,
      validateManifest(JSON.parse(String(row.manifest))),
    );
  }
  remove(owner: string, id: string): void {
    this.get(owner, id);
    this.db.prepare("DELETE FROM plugins WHERE id=? AND owner=?").run(id, owner);
  }
  storageGet(owner: string, id: string, key: string): unknown {
    this.authorize(owner, id, "storage");
    const row = this.db
      .prepare("SELECT value FROM plugin_storage WHERE plugin_id=? AND key=?")
      .get(id, identifier(key));
    return row ? JSON.parse(String(row.value)) : null;
  }
  storageSet(owner: string, id: string, key: string, value: unknown): unknown {
    const plugin = this.authorize(owner, id, "storage");
    identifier(key);
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json) > 16_384) throw new PluginError("invalid");
    if (
      plugin.kind === "arcade" &&
      (key === "highScore" ||
        (key.startsWith("user:") && key.endsWith(":highScore")) ||
        /^user64:[A-Za-z0-9_-]+:highScore$/.test(key))
    ) {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000)
        throw new PluginError("invalid");
      value = Math.max(Number(value), Number(this.storageGet(owner, id, key) ?? 0));
    }
    const count = Number(
      this.db.prepare("SELECT count(*) AS n FROM plugin_storage WHERE plugin_id=?").get(id)?.n,
    );
    if (
      count >= 128 &&
      !this.db.prepare("SELECT key FROM plugin_storage WHERE plugin_id=? AND key=?").get(id, key)
    )
      throw new PluginError("invalid");
    this.db
      .prepare(
        "INSERT INTO plugin_storage VALUES(?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
      )
      .run(id, key, JSON.stringify(value));
    return value;
  }
  authorize(owner: string, id: string, capability: PluginCapability): LifePlugin {
    const plugin = this.get(owner, id);
    if (!plugin.capabilities.includes(capability)) throw new PluginError("forbidden");
    return plugin;
  }
  view(owner: string, id: string): string {
    const plugin = this.get(owner, id);
    if (plugin.kind === "custom") return plugin.html!;
    return readFileSync(new URL(`../templates/${plugin.kind}.html`, import.meta.url), "utf8");
  }
}

export function builtInManifest(request: string): PluginManifest | undefined {
  const text = bounded(request, 8000).toLowerCase();
  if (/\b(arcade|shooter|first.person|high.?score|fps)\b/.test(text))
    return {
      name: "Star arcade",
      description: "A first-person arcade game with your own persistent high score.",
      kind: "arcade",
      capabilities: ["storage"],
    };
  if (/\b(mlb|baseball|standings)\b/.test(text))
    return {
      name: "Around the diamond",
      description: "MLB standings, today's games, and a closer look at every matchup.",
      kind: "mlb",
      capabilities: ["mlb.read"],
    };
  return undefined;
}

export interface MLBSnapshot {
  date: string;
  updatedAt: number;
  stale: boolean;
  error?: string;
  standings: Array<{
    division: string;
    teams: Array<{
      id: number;
      name: string;
      wins: number;
      losses: number;
      pct: string;
      gamesBack: string;
    }>;
  }>;
  games: Array<{
    id: number;
    start: string;
    status: string;
    away: string;
    home: string;
    awayScore?: number;
    homeScore?: number;
    inning?: string;
  }>;
}
/** Fixed provider URLs prevent a plugin from turning this adapter into arbitrary network access. */
export class MLBAdapter {
  private cache = new Map<string, MLBSnapshot>();
  private pending = new Map<string, Promise<MLBSnapshot>>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }
  async snapshot(date: string): Promise<MLBSnapshot> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ||
      new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new PluginError("invalid");
    const cached = this.cache.get(date);
    if (cached && this.now() - cached.updatedAt < 60_000) return structuredClone(cached);
    const inFlight = this.pending.get(date);
    if (inFlight) return structuredClone(await inFlight);
    if (this.pending.size >= 4)
      return {
        ...(cached ? structuredClone(cached) : { date, updatedAt: 0, standings: [], games: [] }),
        stale: true,
        error: "MLB refresh is busy. Try again shortly.",
      };
    const operation = this.load(date, cached);
    this.pending.set(date, operation);
    try {
      return structuredClone(await operation);
    } finally {
      this.pending.delete(date);
    }
  }
  private async read(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("MLB data is unavailable.");
    if (Number(response.headers.get("content-length")) > 2_000_000)
      throw new Error("MLB response exceeds limit.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MLB response is empty.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new Error("MLB response exceeds limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid MLB response.");
    return value as Record<string, unknown>;
  }
  private async load(date: string, cached?: MLBSnapshot): Promise<MLBSnapshot> {
    try {
      const [standings, schedule] = await Promise.all([
        this.read(
          `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${date.slice(0, 4)}&standingsTypes=regularSeason&hydrate=division`,
        ),
        this.read(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`,
        ),
      ]);
      const object = (v: unknown): Record<string, unknown> =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      const array = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 100) : []);
      const label = (v: unknown): string => (typeof v === "string" ? v.slice(0, 200) : "");
      const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      if (!Array.isArray(standings.records) || !Array.isArray(schedule.dates))
        throw new Error("Incomplete MLB response.");
      const snapshot: MLBSnapshot = {
        date,
        updatedAt: this.now(),
        stale: false,
        standings: array(standings.records).map((raw) => {
          const row = object(raw);
          return {
            division:
              label(object(row.division).name) || `Division ${number(object(row.division).id)}`,
            teams: array(row.teamRecords).map((rawTeam) => {
              const team = object(rawTeam);
              return {
                id: number(object(team.team).id),
                name: label(object(team.team).name),
                wins: number(team.wins),
                losses: number(team.losses),
                pct: label(team.winningPercentage),
                gamesBack: label(team.gamesBack),
              };
            }),
          };
        }),
        games: array(schedule.dates)
          .flatMap((day) => array(object(day).games))
          .map((raw) => {
            const game = object(raw),
              teams = object(game.teams),
              away = object(teams.away),
              home = object(teams.home),
              linescore = object(game.linescore);
            return {
              id: number(game.gamePk),
              start: label(game.gameDate),
              status: label(object(game.status).detailedState),
              away: label(object(away.team).name),
              home: label(object(home.team).name),
              ...(typeof away.score === "number" ? { awayScore: number(away.score) } : {}),
              ...(typeof home.score === "number" ? { homeScore: number(home.score) } : {}),
              ...(linescore.currentInning
                ? { inning: `${label(linescore.inningHalf)} ${number(linescore.currentInning)}` }
                : {}),
            };
          }),
      };
      this.cache.set(date, snapshot);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      return snapshot;
    } catch {
      if (cached)
        return {
          ...cached,
          stale: true,
          error: "MLB could not be refreshed. Showing the last successful update.",
        };
      return {
        date,
        updatedAt: 0,
        stale: true,
        error: "MLB is unavailable. Try again when the connection is restored.",
        standings: [],
        games: [],
      };
    }
  }
}
