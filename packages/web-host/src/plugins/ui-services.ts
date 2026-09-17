import type { Context, Plugin } from "cordis";
import "../cordis-augment.js";

/**
 * Ensures ui.* registries remain addressable via ctx.get / dotted provide.
 * createWebHost already provides them; this plugin is the documented install
 * point for apps that boot a bare Context.
 */
export const uiServicesPlugin: Plugin.Function<void> = function uiServicesPlugin(ctx: Context): void {
  // No-op when services were provided at boot; assert presence fail-closed.
  const required = ["ui.nav", "ui.commands", "ui.routes", "ui.inspector", "ui.status", "ui.slots"] as const;
  for (const name of required) {
    if (!ctx.get(name)) {
      throw new Error(`web-host missing service: ${name}`);
    }
  }
};
