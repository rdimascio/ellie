import test from "node:test";
import assert from "node:assert/strict";
import {
  DASHBOARD_STORAGE_KEY,
  DashboardModelError,
  addWidget,
  createDashboard,
  createDefaultDashboardState,
  deleteDashboard,
  loadDashboardState,
  moveWidget,
  parseDashboardState,
  removeWidget,
  renameDashboard,
  saveDashboardState,
  serializeDashboardState,
  updateWidget,
} from "../apps/command-center/src/dashboard-model.ts";
import type { DashboardState } from "../apps/command-center/src/dashboard-model.ts";

function emptyState(): DashboardState {
  return { version: 1 as const, dashboards: [] };
}

test("dashboard and widget edits are immutable and preserve ordering", () => {
  const empty = emptyState();
  const created = createDashboard(empty, { id: "family", name: "Family" });
  const withClock = addWidget(created, "family", {
    id: "clock-one",
    type: "clock",
    title: "Clock",
    size: "small",
    config: { timeZone: "America/Los_Angeles" },
  });
  const withNote = addWidget(withClock, "family", {
    id: "note-one",
    type: "note",
    title: "Note",
    size: "wide",
    config: { text: "Milk is in the fridge." },
  });
  const moved = moveWidget(withNote, "family", "note-one", 0);
  const updated = updateWidget(moved, "family", "note-one", {
    title: "Kitchen note",
    config: { text: "Dinner is at six." },
  });

  assert.deepEqual(empty, { version: 1, dashboards: [] });
  assert.deepEqual(
    withNote.dashboards[0]?.widgets.map(({ id }) => id),
    ["clock-one", "note-one"],
  );
  assert.deepEqual(
    updated.dashboards[0]?.widgets.map(({ id }) => id),
    ["note-one", "clock-one"],
  );
  assert.equal(updated.dashboards[0]?.widgets[0]?.title, "Kitchen note");
  assert.equal(moved.dashboards[0]?.widgets[0]?.title, "Note");

  const renamed = renameDashboard(updated, "family", "Our home");
  const removed = removeWidget(renamed, "family", "clock-one");
  assert.equal(renamed.dashboards[0]?.name, "Our home");
  assert.deepEqual(
    removed.dashboards[0]?.widgets.map(({ id }) => id),
    ["note-one"],
  );
  assert.deepEqual(deleteDashboard(removed, "family"), empty);
});

test("strict parsing rejects unknown fields, versions, duplicates, credential fields and integrations", () => {
  const valid = createDefaultDashboardState();
  const invalid: unknown[] = [
    { ...valid, version: 2 },
    { ...valid, extra: true },
    { version: 1, dashboards: [valid.dashboards[0], valid.dashboards[0]] },
    {
      version: 1,
      dashboards: [
        { id: "x", name: "X", widgets: Array(25).fill(valid.dashboards[0]!.widgets[0]) },
      ],
    },
    {
      version: 1,
      dashboards: [
        {
          id: "x",
          name: "X",
          widgets: [
            {
              id: "bad",
              type: "weather",
              title: "Weather",
              size: "small",
              config: { apiKey: "shh" },
            },
          ],
        },
      ],
    },
    {
      version: 1,
      dashboards: [
        {
          id: "x",
          name: "X",
          widgets: [{ id: "bad", type: "video", title: "Video", size: "small", config: {} }],
        },
      ],
    },
  ];
  for (const value of invalid) assert.throws(() => parseDashboardState(value), DashboardModelError);
  assert.throws(() => parseDashboardState("not json"), DashboardModelError);
});

test("plain notes allow markup-like text and links without adding executable config", () => {
  const parsed = parseDashboardState({
    version: 1,
    dashboards: [
      {
        id: "links",
        name: "Links <and reminders>",
        widgets: [
          {
            id: "note",
            type: "note",
            title: "Read https://example.com",
            size: "wide",
            config: { text: "Use <b>literal text</b> or visit https://example.com after dinner." },
          },
        ],
      },
    ],
  });
  assert.equal(
    parsed.dashboards[0]?.widgets[0]?.config.text,
    "Use <b>literal text</b> or visit https://example.com after dinner.",
  );
});

test("mutation bounds and duplicate ids fail clearly", () => {
  let state = emptyState();
  for (let index = 0; index < 12; index++)
    state = createDashboard(state, { id: `board-${index}`, name: `Board ${index}` });
  assert.throws(
    () => createDashboard(state, { id: "one-more", name: "One more" }),
    /Too many dashboards/,
  );
  assert.throws(
    () => createDashboard(state, { id: "board-1", name: "Again" }),
    /Too many dashboards/,
  );
  assert.throws(
    () => moveWidget(createDefaultDashboardState(), "home", "clock", 2),
    /out of bounds/,
  );
  assert.throws(() => renameDashboard(state, "missing", "New"), /Unknown dashboard/);
});

test("serialization round trips canonical data and storage falls back safely", () => {
  const state = createDefaultDashboardState();
  assert.deepEqual(parseDashboardState(serializeDashboardState(state)), state);

  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  assert.deepEqual(loadDashboardState(storage), state);
  const renamed = renameDashboard(state, "home", "Downstairs");
  saveDashboardState(storage, renamed);
  assert.equal(values.has(DASHBOARD_STORAGE_KEY), true);
  assert.deepEqual(loadDashboardState(storage), renamed);
  values.set(DASHBOARD_STORAGE_KEY, '{"version":99}');
  assert.deepEqual(loadDashboardState(storage), state);
});

function playlistDashboard(youtubePlaylistID: string) {
  return {
    version: 1,
    dashboards: [
      {
        id: "home",
        name: "Home",
        widgets: [
          {
            id: "playlist",
            type: "playlist",
            title: "Listening",
            size: "wide",
            config: { youtubePlaylistID },
          },
        ],
      },
    ],
  };
}

test("browser v1 accepts bounded native YouTube playlist configuration", () => {
  const id = "PLSynthetic_123456789";
  const state = parseDashboardState(playlistDashboard(id));
  assert.equal(state.dashboards[0]?.widgets[0]?.config.youtubePlaylistID, id);
});

test("browser v1 round trips native YouTube playlist configuration", () => {
  const state = parseDashboardState(playlistDashboard("PLSynthetic_123456789"));
  assert.deepEqual(parseDashboardState(serializeDashboardState(state)), state);
});

test("browser v1 rejects invalid native YouTube playlist configuration", () => {
  for (const id of ["not-valid", "PLé12345678901", `PL${"a".repeat(79)}`])
    assert.throws(() => parseDashboardState(playlistDashboard(id)), DashboardModelError);
});
