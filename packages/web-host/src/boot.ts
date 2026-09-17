import { Context } from "cordis";
import type { Plugin } from "cordis";
import "./cordis-augment.js";
import { createUiServices, type UiServices } from "./services/registries.js";

export type WebHost = {
  readonly ctx: Context;
  readonly ui: UiServices;
  dispose: () => void;
};

/**
 * Create a Cordis root Context and install the ui.* extension registries.
 * React remains the renderer; Cordis owns composition / lifecycle.
 */
export function createWebHost(): WebHost {
  const root = new Context();
  const ui = createUiServices();

  // Provide dotted service names expected by the web-host contract.
  root.provide("ui.nav", ui.nav);
  root.provide("ui.commands", ui.commands);
  root.provide("ui.routes", ui.routes);
  root.provide("ui.inspector", ui.inspector);
  root.provide("ui.status", ui.status);
  root.provide("ui.slots", ui.slots);

  return {
    ctx: root,
    ui,
    dispose: () => {
      // Cordis root has no explicit dispose in rc.8; drop references only.
    },
  };
}

/** Install one or more Cordis plugins into the host root. */
export function installPlugins(host: WebHost, plugins: Array<Plugin>): void {
  for (const plugin of plugins) {
    host.ctx.plugin(plugin);
  }
}
