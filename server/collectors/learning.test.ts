import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createStore } from "../store";
import { emptyLearning, learningCollector, parseAgenda, parseDaily } from "./learning";
import type { CollectorContext } from "./types";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "learning");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

const OCT_30 = new Date(2026, 9, 30, 9, 0); // local time

const FIXTURE_STREAK = { current: 4, best: 9, started: "2026-08-18" };
const FIXTURE_CYCLE = {
  concept: "Retries and backoff",
  steps: [
    { label: "READ", done: true },
    { label: "WRITE", done: true },
    { label: "CHECK", done: false },
    { label: "BUILD", done: false },
    { label: "CARD", done: false },
  ],
};
const LIFE_AGENDA = [
  { text: "Learning cycle (READ/WRITE/CHECK/BUILD)", done: false },
  { text: "Office project (day job)", done: false },
  { text: "Listening practice - summary week (due 2026-10-12, done 2026-10-11)", done: true },
  { text: "Side project", done: true },
  { text: "Evening reading", done: false },
];
/** Daily.md without its "## Life Agenda" section, so the monthly agenda file is used. */
const withoutTable = (text: string) => text.replace(/^## Life Agenda[\s\S]*?(?=^## )/m, "");
const CHECKLIST_ITEMS = [
  { text: "Finish the retries cycle", done: true },
  { text: "Write the eval set plan for LegalOS", done: false },
  { text: "Book the dentist appointment", done: true },
  { text: "Read two chapters of the current book", done: false },
];

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-learning-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Writes files into a fresh LEARNING_DIR, keys like "Daily.md" or "Agenda/2026-10.md". */
async function learningDir(files: Record<string, string>): Promise<string> {
  const dir = path.join(tmp, "Learning");
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }
  return dir;
}

function ctx(dir: string, now: Date = OCT_30): CollectorContext<"learning"> {
  return {
    config: loadConfig({ LEARNING_DIR: dir }, { rootDir: tmp, home: tmp }),
    store: createStore(path.join(tmp, "data")),
    now,
    signal: new AbortController().signal,
    previous: { learning: emptyLearning() },
  };
}

describe("parseDaily", () => {
  it("reads the streak, the concept, the cycle steps and the Life Agenda table from the fixture", async () => {
    expect(parseDaily(await fixture("daily.md"))).toEqual({
      streak: FIXTURE_STREAK,
      cycle: FIXTURE_CYCLE,
      agenda: LIFE_AGENDA,
      missing: [],
    });
  });

  it("returns agenda null when the Life Agenda table is missing, without counting it as missing", async () => {
    const parsed = parseDaily(withoutTable(await fixture("daily.md")));
    expect(parsed.agenda).toBeNull();
    expect(parsed.cycle).toEqual(FIXTURE_CYCLE);
    expect(parsed.missing).toEqual([]);
  });

  it("takes agenda rows only from the Life Agenda section and only rows with a checkbox cell", () => {
    const text = [
      "## Other table",
      "| [ ] | **Not agenda** | x |",
      "## Life Agenda",
      "| Done | Task |",
      "| --- | --- |",
      "| [x] |   **Real**   task  (due 2026-11-02) | later |",
      "| no box | **Skipped row** |",
      "```",
      "| [ ] | **Inside a fence** |",
      "```",
    ].join("\n");
    expect(parseDaily(text).agenda).toEqual([{ text: "Real task (due 2026-11-02)", done: true }]);
  });

  it("ignores checkboxes outside Current cycle: agenda table, daily list, code fence, monthly list", async () => {
    const { cycle } = parseDaily(await fixture("daily.md"));
    expect(cycle?.steps.map((s) => s.label)).toEqual(["READ", "WRITE", "CHECK", "BUILD", "CARD"]);
  });

  it("gives the same result for CRLF line endings and a BOM", async () => {
    const text = await fixture("daily.md");
    expect(parseDaily("\uFEFF" + crlf(text))).toEqual(parseDaily(text));
  });

  it("accepts emoji in headings and em dash separators after the step label", async () => {
    const text = (await fixture("daily.md"))
      .replace("## Current cycle", "## \u{1F501} Current Cycle \u{2728}")
      .replace("## Streak", "## \u{1F525} Streak")
      .replace(/\*\* - /g, "** \u2014 ");
    expect(parseDaily(text)).toEqual({ streak: FIXTURE_STREAK, cycle: FIXTURE_CYCLE, agenda: LIFE_AGENDA, missing: [] });
  });

  it("reads step labels written without bold", () => {
    const text = "## Current cycle\n\n- [ ] 1. READ \u2014 a source\n- [x] WRITE: notes from memory\n";
    expect(parseDaily(text).cycle?.steps).toEqual([
      { label: "READ", done: false },
      { label: "WRITE", done: true },
    ]);
  });

  it("parses what it can when the streak line is gone", async () => {
    const text = (await fixture("daily.md")).replace(/^\*\*Current.*$/m, "");
    const parsed = parseDaily(text);
    expect(parsed.streak).toEqual({ current: 0, best: 0, started: null });
    expect(parsed.cycle).toEqual(FIXTURE_CYCLE);
    expect(parsed.missing).toEqual(["streak line"]);
  });

  it("parses a streak line that lost its Best and Started parts", () => {
    const parsed = parseDaily("## Streak\n\n**Current: 3**\n");
    expect(parsed.streak).toEqual({ current: 3, best: 3, started: null });
    expect(parsed.missing).toContain("best streak");
    expect(parsed.missing).toContain("streak start date");
  });

  it("returns cycle null when the Current cycle heading is missing", async () => {
    const text = (await fixture("daily.md")).replace("## Current cycle", "## Something else");
    const parsed = parseDaily(text);
    expect(parsed.cycle).toBeNull();
    expect(parsed.streak).toEqual(FIXTURE_STREAK);
    expect(parsed.missing).toEqual(["Current cycle heading"]);
  });

  it("keeps the steps when the Concept line is missing", async () => {
    const text = (await fixture("daily.md")).replace(/^\*\*Concept.*$/m, "");
    const parsed = parseDaily(text);
    expect(parsed.cycle).toEqual({ concept: "", steps: FIXTURE_CYCLE.steps });
    expect(parsed.missing).toEqual(["Concept line"]);
  });

  it("does not throw on empty or unrelated text", () => {
    expect(parseDaily("")).toEqual({
      streak: { current: 0, best: 0, started: null },
      cycle: null,
      agenda: null,
      missing: ["streak line", "Current cycle heading"],
    });
    expect(() => parseDaily("```\n## Current cycle\n- [ ] **READ**\n")).not.toThrow();
  });
});

describe("parseAgenda", () => {
  it("reads every checkbox line with its done state", async () => {
    expect(parseAgenda(await fixture("agenda-checklist.md"))).toEqual(CHECKLIST_ITEMS);
  });

  it("gives the same result for CRLF line endings and a BOM", async () => {
    const text = await fixture("agenda-checklist.md");
    expect(parseAgenda("\uFEFF" + crlf(text))).toEqual(CHECKLIST_ITEMS);
  });

  it("finds no items in the event-block shape (## title plus key:: value lines)", async () => {
    expect(parseAgenda(await fixture("agenda-events.md"))).toEqual([]);
  });

  it("ignores checkboxes inside code fences", () => {
    expect(parseAgenda("~~~\n- [ ] example\n~~~\n- [x] real\n")).toEqual([{ text: "real", done: true }]);
  });
});

describe("learningCollector", () => {
  it("reads Daily.md and takes the agenda from its Life Agenda table, not the monthly file", async () => {
    const dir = await learningDir({
      "Daily.md": await fixture("daily.md"),
      "Agenda/2026-10.md": await fixture("agenda-checklist.md"),
    });
    const result = await learningCollector.collect(ctx(dir));
    expect(result).toEqual({
      status: "ok",
      data: { learning: { streak: FIXTURE_STREAK, cycle: FIXTURE_CYCLE, agendaThisMonth: LIFE_AGENDA } },
    });
    expect(result.message).toBeUndefined();
  });

  it("uses the Life Agenda table even when there is no monthly agenda file", async () => {
    const dir = await learningDir({ "Daily.md": await fixture("daily.md") });
    const result = await learningCollector.collect(ctx(dir));
    expect(result.status).toBe("ok");
    expect(result.data?.learning.agendaThisMonth).toEqual(LIFE_AGENDA);
    expect(result.message).toBeUndefined();
  });

  it("falls back to Agenda/YYYY-MM.md checkbox lines when the table is missing", async () => {
    const dir = await learningDir({
      "Daily.md": withoutTable(await fixture("daily.md")),
      "Agenda/2026-10.md": await fixture("agenda-checklist.md"),
    });
    const result = await learningCollector.collect(ctx(dir));
    expect(result).toEqual({
      status: "ok",
      data: { learning: { streak: FIXTURE_STREAK, cycle: FIXTURE_CYCLE, agendaThisMonth: CHECKLIST_ITEMS } },
    });
  });

  it("reads CRLF files the same way", async () => {
    const dir = await learningDir({
      "Daily.md": crlf(await fixture("daily.md")),
      "Agenda/2026-10.md": "\uFEFF" + crlf(await fixture("agenda-checklist.md")),
    });
    const result = await learningCollector.collect(ctx(dir));
    expect(result.status).toBe("ok");
    expect(result.data).toEqual({
      learning: { streak: FIXTURE_STREAK, cycle: FIXTURE_CYCLE, agendaThisMonth: LIFE_AGENDA },
    });
  });

  it("falls back to the agenda file of the local month and names it when missing", async () => {
    const dir = await learningDir({
      "Daily.md": withoutTable(await fixture("daily.md")),
      "Agenda/2026-10.md": await fixture("agenda-checklist.md"),
    });
    const result = await learningCollector.collect(ctx(dir, new Date(2026, 10, 1, 8, 0)));
    expect(result.status).toBe("ok");
    expect(result.data?.learning.agendaThisMonth).toEqual([]);
    expect(result.data?.learning.cycle).toEqual(FIXTURE_CYCLE);
    expect(result.message).toContain(path.join(dir, "Agenda", "2026-11.md"));
  });

  it("returns ok with an empty agenda and a note when the fallback file has the event-block shape", async () => {
    const dir = await learningDir({
      "Daily.md": withoutTable(await fixture("daily.md")),
      "Agenda/2026-10.md": await fixture("agenda-events.md"),
    });
    const result = await learningCollector.collect(ctx(dir));
    expect(result.status).toBe("ok");
    expect(result.data?.learning.agendaThisMonth).toEqual([]);
    expect(result.message).toBe("No Life Agenda table in Daily.md and no checkbox items in Agenda/2026-10.md");
  });

  it("is not_connected and names the expected path when Daily.md is missing", async () => {
    const dir = await learningDir({ "Agenda/2026-10.md": await fixture("agenda-checklist.md") });
    const result = await learningCollector.collect(ctx(dir));
    expect(result.status).toBe("not_connected");
    expect(result.message).toContain(path.join(dir, "Daily.md"));
    expect(result.data).toEqual({ learning: emptyLearning() });
  });

  it("is not_connected when LEARNING_DIR does not exist", async () => {
    const dir = path.join(tmp, "no-such-folder");
    const result = await learningCollector.collect(ctx(dir));
    expect(result.status).toBe("not_connected");
    expect(result.message).toContain(path.join(dir, "Daily.md"));
    expect(result.data).toEqual({ learning: emptyLearning() });
  });

  it("returns ok with what it found when Daily.md drifted", async () => {
    const dir = await learningDir({
      "Daily.md": "# Daily\n\n**Current: 2** \u00B7 Best: 5 \u00B7 Started: 2026-09-01\n",
      "Agenda/2026-10.md": await fixture("agenda-checklist.md"),
    });
    const result = await learningCollector.collect(ctx(dir));
    expect(result.status).toBe("ok");
    expect(result.data).toEqual({
      learning: { streak: { current: 2, best: 5, started: "2026-09-01" }, cycle: null, agendaThisMonth: CHECKLIST_ITEMS },
    });
    expect(result.message).toBe("Daily.md: no Current cycle heading found");
  });
});
