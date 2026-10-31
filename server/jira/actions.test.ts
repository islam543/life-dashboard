import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../notes";
import { ACTION_TEXT_MAX, actionContext, actionId, detectActions, isActionHeading, jiraKeyOnLine, joinBody, openActions, splitBody } from "./actions";

const texts = (body: string) => detectActions(body).map((a) => a.text);

describe("detectActions: meeting-template notes", () => {
  it("ignores the template's empty checkbox", () => {
    expect(detectActions(TEMPLATES.meeting)).toEqual([]);
  });

  it("reads checkboxes and plain bullets under Action items, with 1-based body lines", () => {
    const body = [
      "## Attendees", // 1
      "- Ahmed", // 2
      "- Sara", // 3
      "", // 4
      "## Notes", // 5
      "- Budget was discussed", // 6
      "", // 7
      "## Action items", // 8
      "", // 9
      "- [ ] Send the signed slip to finance", // 10
      "- [x] Book the review room", // 11
      "- Ask Sara for the claims export", // 12
    ].join("\n");
    const actions = detectActions(body);
    expect(actions.map((a) => [a.line, a.text, a.done, a.jiraKey])).toEqual([
      [10, "Send the signed slip to finance", false, null],
      [11, "Book the review room", true, null],
      [12, "Ask Sara for the claims export", false, null],
    ]);
    // Attendees and notes bullets are not actions.
    expect(texts(body)).not.toContain("Ahmed");
  });
});

describe("detectActions: mixed bullets", () => {
  it("accepts -, *, + and numbered checkbox markers anywhere, at any depth", () => {
    const body = ["Intro", "* [ ] star box", "+ [X] plus box", "1. [ ] numbered box", "2) [ ] paren box", "  - [ ] nested box", "\t- [ ] tab box"].join("\n");
    expect(detectActions(body).map((a) => [a.text, a.done])).toEqual([
      ["star box", false],
      ["plus box", true],
      ["numbered box", false],
      ["paren box", false],
      ["nested box", false],
      ["tab box", false],
    ]);
  });

  it("takes plain top-level bullets only under action headings, until a heading of the same level", () => {
    const body = [
      "- not an action",
      "## Next steps:",
      "* first step",
      "  - detail, not an action",
      "1. second step",
      "### Islam",
      "- still under next steps",
      "## Decisions",
      "- a decision, not an action",
    ].join("\n");
    expect(texts(body)).toEqual(["first step", "second step", "still under next steps"]);
  });

  it("recognises heading names like the architecture doc lists", () => {
    for (const name of ["Action items", "Action item", "Actions", "Next steps", "To do", "TODO", "To-dos", "Follow-ups", "Follow ups", "**Action items:**", "Action items (Islam)", "✅ Actions"]) {
      expect(isActionHeading(name), name).toBe(true);
    }
    for (const name of ["Notes", "Actions taken", "Decisions", "Attendees", "What to do next week"]) {
      expect(isActionHeading(name), name).toBe(false);
    }
  });

  it("skips fenced code blocks, rules and blank bullets", () => {
    const body = ["## Actions", "```", "- [ ] inside code", "- bullet in code", "```", "* * *", "- ", "~~~", "- [ ] tilde fence", "~~~", "- real one"].join("\n");
    expect(texts(body)).toEqual(["real one"]);
  });
});

describe("detectActions: already-filed lines", () => {
  it("sets jiraKey for a line holding a key and keeps it out of the open actions", () => {
    const body = ["- [ ] Send slip (AN-4602)", "- [ ] Call the broker", "- [x] Done thing", "- [ ] Fix FB-12 regression"].join("\n");
    const actions = detectActions(body);
    // Only AN keys mark a line as filed; FB-12 is another project, so that action stays open.
    expect(actions.map((a) => a.jiraKey)).toEqual(["AN-4602", null, null, null]);
    expect(openActions(actions).map((a) => a.text)).toEqual(["Call the broker", "Fix FB-12 regression"]);
  });

  it("does not treat lowercase or partial keys as filed", () => {
    expect(detectActions("- [ ] check an-12 and AN- and A-1").map((a) => a.jiraKey)).toEqual([null]);
  });
});

describe("detectActions: Arabic text", () => {
  it("keeps Arabic action text as written and gives it a stable id", () => {
    const body = "## Action items\n- [ ] إرسال التقرير إلى أحمد قبل الخميس\n- متابعة المطالبات مع سارة";
    const actions = detectActions(body);
    expect(actions.map((a) => a.text)).toEqual(["إرسال التقرير إلى أحمد قبل الخميس", "متابعة المطالبات مع سارة"]);
    expect(detectActions(body).map((a) => a.id)).toEqual(actions.map((a) => a.id));
  });

  it("files an Arabic line that carries a key", () => {
    expect(detectActions("- [ ] إرسال التقرير (AN-77)")[0]?.jiraKey).toBe("AN-77");
  });
});

describe("ids, lines and limits", () => {
  it("ids are stable for the same text and line, and differ when either changes", () => {
    expect(actionId("Send slip", 4)).toBe(actionId("Send slip", 4));
    expect(actionId("Send slip", 4)).not.toBe(actionId("Send slip", 5));
    expect(actionId("Send slip", 4)).not.toBe(actionId("Send slip.", 4));
    expect(actionId("Send slip", 4)).toMatch(/^act-[0-9a-f]{16}$/);
    const a = detectActions("x\n- [ ] Send slip")[0]!;
    expect(a.id).toBe(actionId("Send slip", 2));
  });

  it("counts CRLF lines the same as LF lines and rebuilds the body byte for byte", () => {
    const lf = "a\n## Actions\n- one\n- [ ] two";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(detectActions(crlf)).toEqual(detectActions(lf));
    expect(joinBody(splitBody(crlf))).toBe(crlf);
    expect(joinBody(splitBody(lf))).toBe(lf);
  });

  it("caps long action text", () => {
    const long = "x".repeat(ACTION_TEXT_MAX + 50);
    const [a] = detectActions(`- [ ] ${long}`);
    expect([...a!.text].length).toBe(ACTION_TEXT_MAX);
    expect(a!.text.endsWith("...")).toBe(true);
  });
});

describe("actionContext", () => {
  it("gives the nearest heading and the lines around the action, capped", () => {
    const body = ["## Claims review", "We agreed the export is late.", "", "- [ ] Ask Sara for the export", "Due Thursday.", "Other", "Far away"].join("\n");
    const context = actionContext(body, 4);
    expect(context).toContain("## Claims review");
    expect(context).toContain("We agreed the export is late.");
    expect(context).toContain("Due Thursday.");
    expect(context).not.toContain("Far away");
    expect(context).not.toContain("Ask Sara");
    expect([...actionContext(body, 4, { max: 30 })].length).toBe(30);
  });
});

describe("already-filed keys belong to the configured project only", () => {
  it("ignores look-alike tokens and other projects", () => {
    const body = "## Action items\n- [ ] Check COVID-19 rules\n- [ ] Verify SHA-256 hashes\n- [ ] Send slip (AN-4602)\n- [ ] Ask about FB-12";
    expect(detectActions(body, "AN").map((a) => a.jiraKey)).toEqual([null, null, "AN-4602", null]);
    expect(jiraKeyOnLine("see AN-12 and AN-13", "AN")).toBe("AN-12");
    expect(jiraKeyOnLine("BAN-12", "AN")).toBeNull();
  });
});
