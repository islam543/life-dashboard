import type { Collector } from "./types";

/** Stub for v1: no calendar integration yet, so the panel shows an honest not-connected state. */
export const calendarCollector: Collector<"calendar"> = {
  key: "calendar",
  async collect() {
    return { status: "not_connected", message: "Connect Google Calendar", data: { calendar: [] } };
  },
};
