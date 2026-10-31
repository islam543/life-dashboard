import { CONNECTORS_FILE, connectorSourceView } from "../connectors/validate";
import { enabledServices } from "../connectors/tools";
import { connectorsIntervalMs } from "../scheduler";
import type { Collector } from "./types";

/**
 * Google Calendar through the Claude connector (ticket T26). Reads data/connectors.json, which
 * the connector run fills (server/connectors/run.ts). Until tools.ts lists a Calendar tool the
 * status is not_connected with the sign-in steps.
 */
export const calendarCollector: Collector<"calendar"> = {
  key: "calendar",
  async collect(ctx) {
    const raw = await ctx.store.read<unknown>(CONNECTORS_FILE, null);
    const view = connectorSourceView("calendar", raw, {
      now: ctx.now,
      everyMs: connectorsIntervalMs(ctx.config.connectors.everyMin),
      hasTools: enabledServices().includes("calendar"),
    });
    return { status: view.status, message: view.message, data: { calendar: view.items } };
  },
};
