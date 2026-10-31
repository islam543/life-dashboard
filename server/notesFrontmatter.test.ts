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
  serializeNoteFile,
  setEntry,
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
