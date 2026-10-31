import { describe, expect, it } from "vitest";
import { openItem, openLabel, opensIn, safeLink, siteName } from "./linkMenu";

describe("safeLink", () => {
  it("keeps in-app routes and http(s) addresses", () => {
    expect(safeLink("#/projects/abc")).toBe("#/projects/abc");
    expect(safeLink("https://acme.atlassian.net/browse/FB-1")).toBe("https://acme.atlassian.net/browse/FB-1");
    expect(safeLink(" http://localhost:4317/x ")).toBe("http://localhost:4317/x");
  });

  it("refuses scripts, other schemes, bare hashes and empty values", () => {
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("file:///C:/secret.txt")).toBeNull();
    expect(safeLink("mailto:someone@example.com")).toBeNull();
    expect(safeLink("#")).toBeNull();
    expect(safeLink("not a url")).toBeNull();
    expect(safeLink("")).toBeNull();
    expect(safeLink(undefined)).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});

describe("siteName", () => {
  it("names the sites the dashboard links to", () => {
    expect(siteName("https://github.com/islam/repo/pull/42")).toBe("GitHub");
    expect(siteName("https://acme.atlassian.net/browse/FB-1")).toBe("Jira");
    expect(siteName("https://calendar.google.com/event?eid=1")).toBe("Google Calendar");
    expect(siteName("https://mail.google.com/mail/u/0/#inbox/1")).toBe("Gmail");
  });

  it("falls back to the host, without www", () => {
    expect(siteName("https://www.example.org/page")).toBe("example.org");
  });

  it("gives null for in-app links and bad addresses", () => {
    expect(siteName("#/notes/a.md")).toBeNull();
    expect(siteName("nonsense")).toBeNull();
  });
});

describe("openLabel", () => {
  it("says where an outside link opens", () => {
    expect(openLabel("https://github.com/a/b/pull/1")).toBe("Open in GitHub");
    expect(openLabel("https://acme.atlassian.net/browse/FB-1")).toBe("Open in Jira");
    expect(openLabel("https://www.example.org/")).toBe("Open in example.org");
  });

  it("names the thing for in-app links", () => {
    expect(openLabel("#/projects/fastbind")).toBe("Open project");
    expect(openLabel("#/notes/Meetings%2Fa.md")).toBe("Open note");
    expect(openLabel("#/map")).toBe("Open");
  });
});

describe("opensIn", () => {
  it("matches the hover help on the visible links", () => {
    expect(opensIn("https://github.com/a/b")).toBe("Opens it on GitHub in a new tab");
    expect(opensIn("#/projects/x")).toBe("Opens it on the Projects page of this dashboard");
    expect(opensIn("#/notes/x.md")).toBe("Opens the note in the Notes view of this dashboard");
    expect(opensIn("#/map")).toBe("Opens it here in the dashboard");
    expect(opensIn("nonsense")).toBe("Opens it in a new tab");
  });
});

describe("openItem", () => {
  it("builds the open action with a label and tip", () => {
    const item = openItem("https://acme.atlassian.net/browse/FB-1");
    expect(item?.label).toBe("Open in Jira");
    expect(item?.tip).toBe("Opens it on Jira in a new tab.");
    expect(openItem("#/projects/x", "Opens this project.")?.tip).toBe("Opens this project.");
  });

  it("leaves the item out when there is no safe link", () => {
    expect(openItem(undefined)).toBeNull();
    expect(openItem("javascript:void(0)")).toBeNull();
  });
});
