import { describe, expect, it } from "vitest";
import { copyText, fullPath } from "./filePaths";

describe("fullPath", () => {
  it("joins a Windows notes folder with backslashes", () => {
    expect(fullPath("C:\\Vault\\notes", "Meeting notes/FastBind")).toBe("C:\\Vault\\notes\\Meeting notes\\FastBind");
    expect(fullPath("C:\\Vault\\notes", "Meeting notes/2026-10-30-review.md")).toBe(
      "C:\\Vault\\notes\\Meeting notes\\2026-10-30-review.md",
    );
  });

  it("joins a posix notes folder with slashes", () => {
    expect(fullPath("/home/islam/vault/notes", "Personal notes/today.md")).toBe("/home/islam/vault/notes/Personal notes/today.md");
  });

  it("returns the folder itself for All notes", () => {
    expect(fullPath("C:\\Vault\\notes", "")).toBe("C:\\Vault\\notes");
    expect(fullPath("/vault/notes/", "")).toBe("/vault/notes/");
  });

  it("does not double a trailing separator", () => {
    expect(fullPath("C:\\Vault\\notes\\", "A")).toBe("C:\\Vault\\notes\\A");
    expect(fullPath("C:\\", "A/b.md")).toBe("C:\\A\\b.md");
    expect(fullPath("/", "A/b.md")).toBe("/A/b.md");
  });

  it("follows the folder's own separator", () => {
    expect(fullPath("C:/Vault/notes", "A/b.md")).toBe("C:/Vault/notes/A/b.md");
  });

  it("ignores stray slashes in the relative path", () => {
    expect(fullPath("C:\\Vault\\notes", "/A//b.md")).toBe("C:\\Vault\\notes\\A\\b.md");
  });

  it("keeps Arabic and spaced names as they are", () => {
    expect(fullPath("/vault/notes", "ملاحظات/اجتماع.md")).toBe("/vault/notes/ملاحظات/اجتماع.md");
  });
});

describe("copyText", () => {
  it("resolves false when there is no clipboard", async () => {
    expect(await copyText("x")).toBe(false);
  });
});
