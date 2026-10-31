import type { Collector } from "./types";

/** Stub for v1: no mail integration yet, so the panel shows an honest not-connected state. */
export const emailCollector: Collector<"email"> = {
  key: "email",
  async collect() {
    return { status: "not_connected", message: "Connect Gmail", data: { email: [] } };
  },
};
