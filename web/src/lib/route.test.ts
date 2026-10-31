import { describe, expect, it } from "vitest";
import { noteHash, parseHash, projectHash, toHash, type HashRoute } from "./route";

describe("parseHash", () => {
  it("reads Home from an empty or bare hash", () => {
    for (const h of ["", "#", "#/", "#//"]) expect(parseHash(h)).toEqual({ view: "home" });
  });

  it("reads the Life map", () => {
    expect(parseHash("#/map")).toEqual({ view: "map" });
    expect(parseHash("#map")).toEqual({ view: "map" });
  });

  it("reads the projects board and one project", () => {
    expect(parseHash("#/projects")).toEqual({ view: "projects", id: null });
    expect(parseHash("#/projects/")).toEqual({ view: "projects", id: null });
    expect(parseHash("#/projects/qic-fastbind")).toEqual({ view: "projects", id: "qic-fastbind" });
    expect(parseHash("#/Projects/qic-fastbind")).toEqual({ view: "projects", id: "qic-fastbind" });
    expect(parseHash("#/projects/caf%C3%A9-2")).toEqual({ view: "projects", id: "café-2" });
  });

  it("reads the notes list and one note", () => {
    expect(parseHash("#/notes")).toEqual({ view: "notes", path: null });
    expect(parseHash("#/notes/")).toEqual({ view: "notes", path: null });
    expect(parseHash("#/notes/2026-10-30-standup.md")).toEqual({ view: "notes", path: "2026-10-30-standup.md" });
  });

  it("reads a note path with an encoded slash, and with a plain one", () => {
    const path = "Meeting notes/FastBind/2026-10-30-sprint-review.md";
    expect(parseHash("#/notes/Meeting%20notes%2FFastBind%2F2026-10-30-sprint-review.md")).toEqual({ view: "notes", path });
    expect(parseHash("#/notes/Meeting%20notes/FastBind/2026-10-30-sprint-review.md")).toEqual({ view: "notes", path });
  });

  it("reads Arabic note paths", () => {
    const path = "Personal notes/2026-10-30-ملاحظة.md";
    expect(parseHash(`#/notes/${encodeURIComponent(path)}`)).toEqual({ view: "notes", path });
  });

  it("falls back to the list when the encoding is broken", () => {
    expect(parseHash("#/notes/%E0%A4%A")).toEqual({ view: "notes", path: null });
    expect(parseHash("#/projects/%")).toEqual({ view: "projects", id: null });
  });

  it("falls back to Home for anything else", () => {
    for (const h of ["#/nope", "#main", "#/home/x", "#/mapx"]) expect(parseHash(h)).toEqual({ view: "home" });
  });
});

describe("toHash", () => {
  it("builds every route", () => {
    expect(toHash({ view: "home" })).toBe("#/");
    expect(toHash({ view: "map" })).toBe("#/map");
    expect(toHash({ view: "projects", id: null })).toBe("#/projects");
    expect(toHash({ view: "projects", id: "qic-fastbind" })).toBe("#/projects/qic-fastbind");
    expect(toHash({ view: "notes", path: null })).toBe("#/notes");
    expect(toHash({ view: "notes", path: "Meeting notes/2026-10-30-review.md" })).toBe(
      "#/notes/Meeting%20notes%2F2026-10-30-review.md",
    );
    expect(projectHash()).toBe("#/projects");
    expect(projectHash("a b")).toBe("#/projects/a%20b");
    expect(noteHash(null)).toBe("#/notes");
    expect(noteHash("x/y.md")).toBe("#/notes/x%2Fy.md");
  });

  it("round-trips through parseHash", () => {
    const routes: HashRoute[] = [
      { view: "home" },
      { view: "map" },
      { view: "projects", id: null },
      { view: "projects", id: "learning-cycle" },
      { view: "notes", path: null },
      { view: "notes", path: "Meeting notes/FastBind (QIC)/2026-10-30-review, part 2 & more.md" },
      { view: "notes", path: "Personal notes/2026-10-30-ملاحظة.md" },
    ];
    for (const r of routes) expect(parseHash(toHash(r))).toEqual(r);
  });
});
