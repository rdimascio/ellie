import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addCalendarDays,
  CalendarTimeError,
  calendarDateKey,
  localParts,
  nextAnnualDate,
  nextWeekdayDate,
  parseCalendarDate,
  parseClock,
  resolveZoned,
  startOfLocalDay,
  validateCalendarDate,
  zonedCandidates,
} from "../packages/life-time/src/index.ts";

const code = (expected: string) => (error: unknown) =>
  error instanceof CalendarTimeError && error.code === expected;

test("calendar dates preserve actual years, leap rules, and local day arithmetic", () => {
  assert.deepEqual(parseCalendarDate("0099-02-28"), { year: 99, month: 2, day: 28 });
  assert.equal(calendarDateKey(addCalendarDays({ year: 99, month: 12, day: 31 }, 1)), "0100-01-01");
  for (const invalid of [
    "2026-02-29",
    "1900-02-29",
    "2026-13-01",
    "2026-04-31",
    "2026-1-2",
    "0000-01-01",
  ])
    assert.equal(parseCalendarDate(invalid), undefined, invalid);
  assert.deepEqual(validateCalendarDate({ year: 2000, month: 2, day: 29 }), {
    year: 2000,
    month: 2,
    day: 29,
  });
  assert.equal(
    calendarDateKey(addCalendarDays({ year: 2028, month: 2, day: 28 }, 1)),
    "2028-02-29",
  );
  assert.equal(
    calendarDateKey(addCalendarDays({ year: 2026, month: 3, day: 1 }, -1)),
    "2026-02-28",
  );
  assert.throws(() => addCalendarDays({ year: 9999, month: 12, day: 31 }, 1), code("invalid-date"));
  assert.throws(
    () => addCalendarDays({ year: 2026, month: 1, day: 1 }, Infinity),
    code("invalid-date"),
  );
});

test("exact wall-clock resolution rejects gaps and distinguishes repeated minutes", () => {
  const gap = { year: 2026, month: 3, day: 8, hour: 2, minute: 30 };
  assert.deepEqual(zonedCandidates(gap, "America/Los_Angeles"), []);
  assert.throws(() => resolveZoned(gap, "America/Los_Angeles"), code("nonexistent-time"));
  const repeated = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };
  const candidates = zonedCandidates(repeated, "America/Los_Angeles");
  assert.deepEqual(
    candidates.map((at) => new Date(at).toISOString()),
    ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"],
  );
  assert.throws(() => resolveZoned(repeated, "America/Los_Angeles"), code("ambiguous-time"));
  assert.equal(
    resolveZoned(repeated, "America/Los_Angeles", { ambiguous: "earlier" }),
    candidates[0],
  );
  assert.equal(
    resolveZoned(repeated, "America/Los_Angeles", { ambiguous: "later" }),
    candidates[1],
  );
  assert.throws(() => resolveZoned({ ...repeated, hour: 24 }, "UTC"), code("invalid-time"));
  assert.throws(() => zonedCandidates(repeated, "Not/AZone"), code("invalid-zone"));
});

test("half-hour transitions and non-hour offsets retain the requested minute and second", () => {
  const lordHowe = { year: 2026, month: 10, day: 4, hour: 2, minute: 30, second: 17 };
  const at = resolveZoned(lordHowe, "Australia/Lord_Howe");
  assert.equal(new Date(at).toISOString(), "2026-10-03T15:30:17.000Z");
  assert.deepEqual(localParts(at, "Australia/Lord_Howe"), { ...lordHowe, weekday: 0 });
  assert.deepEqual(zonedCandidates({ ...lordHowe, minute: 15 }, "Australia/Lord_Howe"), []);
  const repeated = zonedCandidates(
    { year: 2026, month: 4, day: 5, hour: 1, minute: 45 },
    "Australia/Lord_Howe",
  );
  assert.equal(repeated.length, 2);
  assert.equal(repeated[1]! - repeated[0]!, 30 * 60_000);
  const nepal = resolveZoned(
    { year: 2026, month: 9, day: 14, hour: 9, minute: 15 },
    "Asia/Kathmandu",
  );
  assert.equal(new Date(nepal).toISOString(), "2026-09-14T03:30:00.000Z");
});

test("annual and weekday dates follow the profile's local day and real leap years", () => {
  const now = Date.parse("2026-09-14T11:30:00Z");
  assert.equal(calendarDateKey(nextAnnualDate({ month: 2, day: 29 }, now, "UTC")), "2028-02-29");
  assert.equal(
    calendarDateKey(
      nextAnnualDate({ month: 2, day: 29 }, Date.parse("2097-01-01T00:00:00Z"), "UTC"),
    ),
    "2104-02-29",
  );
  assert.equal(
    calendarDateKey(nextAnnualDate({ month: 9, day: 14 }, now, "Pacific/Kiritimati")),
    "2027-09-14",
  );
  assert.equal(
    calendarDateKey(nextAnnualDate({ month: 9, day: 14 }, now, "America/Los_Angeles")),
    "2026-09-14",
  );
  const monday = { year: 2026, month: 9, day: 14 };
  assert.equal(calendarDateKey(nextWeekdayDate(monday, 1)), "2026-09-21");
  assert.equal(calendarDateKey(nextWeekdayDate(monday, 1, true)), "2026-09-14");
  assert.equal(calendarDateKey(nextWeekdayDate(monday, 2)), "2026-09-15");
  assert.throws(() => nextAnnualDate({ month: 2, day: 30 }, now, "UTC"), code("invalid-date"));
});

test("clock input requires valid 12-hour or 24-hour fields", () => {
  assert.deepEqual(parseClock("12 am"), { hour: 0, minute: 0 });
  assert.deepEqual(parseClock("12:45 PM"), { hour: 12, minute: 45 });
  assert.deepEqual(parseClock("9:05pm"), { hour: 21, minute: 5 });
  assert.deepEqual(parseClock("23:59"), { hour: 23, minute: 59 });
  for (const value of ["0am", "13pm", "24:00", "12:60", "-1:00", "4:3", "noon tomorrow"])
    assert.throws(() => parseClock(value), code("invalid-time"), value);
});

test("local day boundaries handle extreme zones, DST day lengths and skipped dates", () => {
  assert.equal(
    new Date(
      startOfLocalDay({ year: 2026, month: 9, day: 15 }, "Pacific/Kiritimati")!,
    ).toISOString(),
    "2026-09-14T10:00:00.000Z",
  );
  const spring = startOfLocalDay({ year: 2026, month: 3, day: 8 }, "America/Los_Angeles")!;
  const following = startOfLocalDay({ year: 2026, month: 3, day: 9 }, "America/Los_Angeles")!;
  assert.equal(following - spring, 23 * 3_600_000);
  const brazil = startOfLocalDay({ year: 2018, month: 11, day: 4 }, "America/Sao_Paulo")!;
  assert.equal(localParts(brazil, "America/Sao_Paulo").hour, 1);
  assert.equal(startOfLocalDay({ year: 2011, month: 12, day: 30 }, "Pacific/Apia"), undefined);
});
