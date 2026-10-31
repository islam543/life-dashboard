import { afterEach, describe, expect, it, vi } from "vitest";

// Node has no localStorage or document; each test installs fakes and re-imports the module.

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

async function load(storage: unknown) {
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { documentElement: root });
  vi.resetModules();
  return { theme: await import("./theme"), root };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme switch", () => {
  it("defaults to dark, then saves and applies light", async () => {
    const storage = fakeStorage();
    const { theme, root } = await load(storage);
    expect(theme.currentTheme()).toBe("dark");

    theme.setTheme("light");
    expect(theme.currentTheme()).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(storage.data.get("life-dashboard:theme")).toBe("light");

    theme.setTheme("dark");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("reads a saved light choice and ignores unknown values", async () => {
    expect((await load(fakeStorage({ "life-dashboard:theme": "light" }))).theme.currentTheme()).toBe("light");
    expect((await load(fakeStorage({ "life-dashboard:theme": "pink" }))).theme.currentTheme()).toBe("dark");
  });
});
