import { CONNECTORS_FILE, connectorSourceView } from "../connectors/validate";
import { enabledServices } from "../connectors/tools";
import { connectorsIntervalMs } from "../scheduler";
import type { Collector } from "./types";

/**
 * Gmail through the Claude connector (ticket T26): unread inbox senders and subjects only.
 * Reads data/connectors.json, which the connector run fills (server/connectors/run.ts). Until
 * tools.ts lists a Gmail tool the status is not_connected with the sign-in steps.
 */
export const emailCollector: Collector<"email"> = {
  key: "email",
  async collect(ctx) {
    const raw = await ctx.store.read<unknown>(CONNECTORS_FILE, null);
    const view = connectorSourceView("email", raw, {
      now: ctx.now,
      everyMs: connectorsIntervalMs(ctx.config.connectors.everyMin),
      hasTools: enabledServices().includes("email"),
    });
    return { status: view.status, message: view.message, data: { email: view.items } };
  },
};
