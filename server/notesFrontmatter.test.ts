import { describe, expect, it } from "vitest";
import {
  excerptOf,
  fieldLine,
  firstHeading,
  formatLocalIso,
  openActionLines,
  parseNoteFile,
  parseScalar,
  readFields,
  readTaskFields,
  serializeNoteFile,
  setEntry,
  setTaskEntries,
  withFirstHeading,
  yamlString,
} from "./notesFrontmatter";

const DASHBOARD_NOTE = [
  "---",
  "title: Sprint review with underwriting",
  "created: 2026-10-30T14:05:00+03:00",
  "updated: 2026-10-30T14:40:00+03:00",
  "project: qic-fastbind",
  "tags: [meeting, fastbind]",
  "---",
  "",
  "## Notes",
  "",
  "- [ ] Send the minutes",
  "",
].join("\n");

describe("parseNoteFile and serializeNoteFile", () => {
  it("round-trips a dashboard-made note byte for byte", () => {
    const parsed = parseNoteFile(DASHBOARD_NOTE);
    expect(parsed.body).toBe("## Notes\n\n- [ ] Send the minutes\n");
    expect(serializeNoteFile(parsed.frontmatter!, parsed.body)).toBe(DASHBOARD_NOTE);
    expect(readFields(parsed.frontmatter)).toEqual({
      title: "Sprint review with underwriting",
      created: "2026-10-30T14:05:00+03:00",
      updated: "2026-10-30T14:40:00+03:00",
      projectId: "qic-fastbind",
      tags: ["meeting", "fastbind"],
    });
  });

  it("round-trips empty bodies and bodies that start with blank lines", () => {
    for (const body of ["", "x", "\nx", "\n\n# Title\n"]) {
      const text = serializeNoteFile([{ key: "title", lines: ["title: A"] }], body);
      expect(parseNoteFile(text).body).toBe(body);
    }
  });

  it("reads a file without frontmatter as all body", () => {
    expect(parseNoteFile("# Hello\n\ntext")).toEqual({ frontmatter: null, body: "# Hello\n\ntext" });
  });

  it("treats an unclosed --- block as body", () => {
    const text = "---\ntitle: x\nno closing fence";
    expect(parseNoteFile(text)).toEqual({ frontmatter: null, body: text });
  });

  it("drops a BOM and turns CRLF and CR into LF", () => {
    const parsed = parseNoteFile("\uFEFF---\r\ntitle: Win\r\n---\r\n\r\nline one\r\nline two\rline three");
    expect(readFields(parsed.frontmatter).title).toBe("Win");
    expect(parsed.body).toBe("line one\nline two\nline three");
  });

  it("keeps keys it does not own, comments and nested values verbatim", () => {
    const text = [
      "---",
      "aliases:",
      "  - Review",
      "# a comment",
      "title: Old",
      "cssclasses: [wide]",
      "---",
      "body",
    ].join("\n");
    const parsed = parseNoteFile(text);
    const entries = setEntry(parsed.frontmatter!, "title", fieldLine.title("New"));
    expect(serializeNoteFile(entries, parsed.body)).toBe(text.replace("title: Old", "title: New").replace("---\nbody", "---\n\nbody"));
  });
});

describe("readFields", () => {
  it("reads quoted scalars, comments, null and block lists", () => {
    const parsed = parseNoteFile(
      [
        "---",
        'title: "Q4: plan #2"',
        "created: '2026-10-01'",
        "updated: 2026-10-02T08:00:00Z   # trailing comment",
        "project: ~",
        "tags:",
        "  - '#work'",
        "  - fast-bind",
        "  - bad tag",
        "  - WORK",
        "---",
      ].join("\n"),
    );
    expect(readFields(parsed.frontmatter)).toEqual({
      title: "Q4: plan #2",
      created: "2026-10-01",
      updated: "2026-10-02T08:00:00Z",
      projectId: null,
      tags: ["work", "fast-bind"],
    });
  });

  it("reads flow lists with quoted commas and a scalar tag list", () => {
    expect(readFields(parseNoteFile('---\ntags: [a, "b,c", \'d\']\n---').frontmatter).tags).toEqual(["a", "d"]);
    expect(readFields(parseNoteFile("---\ntags: alpha, beta\n---").frontmatter).tags).toEqual(["alpha", "beta"]);
  });

  it("gives null for missing keys and an empty project", () => {
    expect(readFields(parseNoteFile("---\nproject:\n---").frontmatter)).toEqual({
      title: null,
      created: null,
      updated: null,
      projectId: null,
      tags: null,
    });
    expect(readFields(null).title).toBeNull();
  });
});

describe("setEntry", () => {
  it("replaces in place, drops duplicates of the key and appends new keys", () => {
    const entries = [
      { key: "title", lines: ["title: a"] },
      { key: "other", lines: ["other: 1"] },
      { key: "title", lines: ["title: b"] },
    ];
    expect(setEntry(entries, "title", "title: c")).toEqual([
      { key: "title", lines: ["title: c"] },
      { key: "other", lines: ["other: 1"] },
    ]);
    expect(setEntry([], "tags", "tags: []")).toEqual([{ key: "tags", lines: ["tags: []"] }]);
  });
});

describe("yamlString", () => {
  it("writes plain text plainly and quotes anything YAML could misread", () => {
    expect(yamlString("Sprint review")).toBe("Sprint review");
    expect(yamlString("اجتماع المراجعة")).toBe("اجتماع المراجعة");
    for (const tricky of ["Q4: plan", "C #2", "2026", "yes", "- item", "[x]", 'say "hi"', "trailing ", "'quoted'"]) {
      const line = fieldLine.title(tricky);
      expect(line).not.toBe(`title: ${tricky}`);
      expect(readFields(parseNoteFile(`---\n${line}\n---`).frontmatter).title).toBe(tricky);
    }
  });

  it("parses what it writes", () => {
    expect(parseScalar(yamlString('a "b" \\ c'))).toBe('a "b" \\ c');
  });
});

describe("body helpers", () => {
  const body = [
    "Intro line",
    "```",
    "# not a heading",
    "- [ ] not a task",
    "```",
    "# Real heading #",
    "- [ ] Send minutes",
    "* [ ] Book room",
    "1. [ ] Call Sara",
    "- [x] Done already",
    "- [ ] ",
    "- [ ]",
  ].join("\n");

  it("finds the first heading outside code blocks", () => {
    expect(firstHeading(body)).toBe("Real heading");
    expect(firstHeading("no heading\n## level two")).toBeNull();
  });

  it("counts unchecked task lines with text, outside code blocks", () => {
    expect(openActionLines(body)).toEqual(["Send minutes", "Book room", "Call Sara"]);
    expect(openActionLines("- [ ] a\r\n- [ ] b")).toHaveLength(2);
  });

  it("builds an excerpt without headings or markers, at most 300 characters", () => {
    expect(excerptOf("# Title\n\n- [ ] Send minutes\n> quoted\nplain   text")).toBe("Send minutes quoted plain text");
    const long = excerptOf("word ".repeat(200));
    expect([...long].length).toBeLessThanOrEqual(300);
    expect(long.endsWith("...")).toBe(true);
    expect(excerptOf("## Attendees\n\n## Action items\n\n- [ ] \n")).toBe("");
  });

  it("formats local time with its offset, readable by Date", () => {
    const d = new Date(2026, 9, 30, 14, 5, 7);
    const iso = formatLocalIso(d);
    expect(iso).toMatch(/^2026-10-30T14:05:07[+-]\d\d:\d\d$/);
    expect(Date.parse(iso)).toBe(d.getTime());
  });
});

describe("task fields (v1.2)", () => {
  const TASK_NOTE = [
    "---",
    "title: Write the UAT plan",
    "created: 2026-10-31T09:00:00+03:00",
    "updated: 2026-10-31T09:00:00+03:00",
    "project: qic-fastbind",
    "tags: []",
    "task_due: 2026-11-02",
    'task_start: "09:30"',
    "task_minutes: 45",
    "task_done: false",
    "task_source: ai",
    "aliases: [uat]",
    "---",
    "",
    "# Write the UAT plan",
    "",
  ].join("\n");

  it("round-trips a task note byte for byte and reads every task field", () => {
    const parsed = parseNoteFile(TASK_NOTE);
    expect(serializeNoteFile(parsed.frontmatter!, parsed.body)).toBe(TASK_NOTE);
    expect(readTaskFields(parsed.frontmatter)).toEqual({ due: "2026-11-02", start: "09:30", minutes: 45, done: false, source: "ai" });
  });

  it("writes the fields it is given and keeps every other line verbatim", () => {
    const parsed = parseNoteFile(TASK_NOTE);
    const entries = setTaskEntries(parsed.frontmatter!, { done: true, start: null });
    const text = serializeNoteFile(entries, parsed.body);
    expect(text).toContain("task_done: true\n");
    expect(text).toContain("task_start:\n");
    expect(text).toContain("task_due: 2026-11-02\n");
    expect(text).toContain("aliases: [uat]\n");
    expect(readTaskFields(parseNoteFile(text).frontmatter)).toEqual({ due: "2026-11-02", start: null, minutes: 45, done: true, source: "ai" });
  });

  it("writes a full set that reads back the same", () => {
    const task = { due: "2027-02-28", start: "17:05", minutes: 240, done: false, source: "me" as const };
    const text = serializeNoteFile(setTaskEntries([], task), "# x\n");
    expect(text).toBe('---\ntask_due: 2027-02-28\ntask_start: "17:05"\ntask_minutes: 240\ntask_done: false\ntask_source: me\n---\n\n# x\n');
    expect(readTaskFields(parseNoteFile(text).frontmatter)).toEqual(task);
    const empty = serializeNoteFile(setTaskEntries([], { due: null, start: null, minutes: null }), "");
    expect(readTaskFields(parseNoteFile(empty).frontmatter)).toEqual({ due: null, start: null, minutes: null, done: false, source: "me" });
  });

  it("reads bad values from a note edited in Obsidian as unset, never throwing", () => {
    const bad = [
      "---",
      "task_due: tomorrow",
      "task_start: 25:00",
      "task_minutes: -5",
      "task_done: maybe",
      "task_source: robot",
      "---",
    ].join("\n");
    expect(readTaskFields(parseNoteFile(bad).frontmatter)).toEqual({ due: null, start: null, minutes: null, done: false, source: "me" });
    const odd = ["---", "task_due: 2026-02-30", "task_start: 9:05", "task_minutes: 99999", "task_done: Yes", "task_minutes: 30", "---"].join("\n");
    // 2026-02-30 is not a real date; 9:05 reads as 09:05; the first task_minutes key wins.
    expect(readTaskFields(parseNoteFile(odd).frontmatter)).toEqual({ due: null, start: "09:05", minutes: null, done: true, source: "me" });
    expect(readTaskFields(null)).toEqual({ due: null, start: null, minutes: null, done: false, source: "me" });
    expect(readTaskFields(parseNoteFile("---\ntask_due:\n  - a\n  - b\ntask_done: [true]\n---\n").frontmatter)).toMatchObject({ due: null, done: false });
  });

  it("withFirstHeading renames the first # heading outside code blocks, or adds one", () => {
    expect(withFirstHeading("# Old\n\nDetails\n# Second\n", "New")).toBe("# New\n\nDetails\n# Second\n");
    expect(withFirstHeading("```\n# not this\n```\n# Old\n", "New")).toBe("```\n# not this\n```\n# New\n");
    expect(withFirstHeading("Just text\n", "New")).toBe("# New\n\nJust text\n");
    expect(withFirstHeading("", "New")).toBe("# New\n");
    expect(withFirstHeading("## Sub\n", "New")).toBe("# New\n\n## Sub\n");
  });
});
