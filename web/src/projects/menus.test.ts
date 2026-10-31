import { describe, expect, it } from "vitest";
import { absoluteLink, areaChoices, laneAdd, moveLabel, moveTargets } from "./menus";

describe("moveTargets", () => {
  it("offers every other status in board order", () => {
    expect(moveTargets("active")).toEqual(["paused", "idea", "done"]);
    expect(moveTargets("idea")).toEqual(["active", "paused", "done"]);
    expect(moveTargets("done")).toEqual(["active", "paused", "idea"]);
  });

  it("never offers the current status", () => {
    for (const s of ["active", "paused", "idea", "done"] as const) expect(moveTargets(s)).not.toContain(s);
  });
});

describe("moveLabel", () => {
  it("names the lane the card lands in", () => {
    expect(moveLabel("idea")).toBe("Move to Ideas");
    expect(moveLabel("paused")).toBe("Move to Paused");
  });
});

describe("laneAdd", () => {
  it("adds an idea from the Ideas lane with Idea picked", () => {
    expect(laneAdd("idea")).toMatchObject({ label: "Add idea", status: "idea" });
  });

  it("starts Active and Paused projects from their lanes", () => {
    expect(laneAdd("active")).toMatchObject({ label: "New project", status: "active" });
    expect(laneAdd("paused")).toMatchObject({ label: "Add paused project", status: "paused" });
  });

  it("offers nothing in Done, since a new project can't start finished", () => {
    expect(laneAdd("done")).toBeNull();
  });
});

describe("areaChoices", () => {
  const counts = { all: 7, work: 4, learning: 2, personal: 1 };

  it("leaves out the filter already shown and keeps the counts", () => {
    const choices = areaChoices("all", counts);
    expect(choices.map((c) => c.value)).toEqual(["work", "learning", "personal"]);
    expect(choices[0]).toMatchObject({ label: "Show only Work", hint: "4" });
  });

  it("offers Show all areas when a filter is on", () => {
    expect(areaChoices("work", counts)[0]).toMatchObject({ value: "all", label: "Show all areas", hint: "7" });
  });
});

describe("absoluteLink", () => {
  it("joins the page address and the hash route", () => {
    expect(absoluteLink("#/projects/a%20b", { origin: "http://localhost:4317", pathname: "/" })).toBe(
      "http://localhost:4317/#/projects/a%20b",
    );
  });

  it("keeps a query string and adds a missing #", () => {
    expect(absoluteLink("/projects", { origin: "http://x", pathname: "/app", search: "?v=1" })).toBe("http://x/app?v=1#/projects");
  });
});
