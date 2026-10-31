import { afterEach, describe, expect, it, vi } from "vitest";

// Node has no localStorage; each test installs a fake one and re-imports the module so it re-reads it.

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

async function load(storage: unknown) {
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  return import("./tips");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hover help switch", () => {
  it("is on by default and remembers being turned off", async () => {
    const storage = fakeStorage();
    const tips = await load(storage);
    expect(tips.tipsEnabled()).toBe(true);
    tips.setTipsEnabled(false);
    expect(tips.tipsEnabled()).toBe(false);
    expect(storage.data.get("life-dashboard:tips")).toBe("off");

    const reloaded = await load(storage);
    expect(reloaded.tipsEnabled()).toBe(false);
  });

  it("stays on when storage is blocked", async () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const tips = await load(blocked);
    expect(tips.tipsEnabled()).toBe(true);
    tips.setTipsEnabled(false);
    expect(tips.tipsEnabled()).toBe(false);
  });
});
