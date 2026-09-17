import type { UiServices } from "./services/registries.js";

declare module "cordis" {
  interface Context {
    /** Extension registries for the web renderer host. */
    "ui.nav": UiServices["nav"];
    "ui.commands": UiServices["commands"];
    "ui.routes": UiServices["routes"];
    "ui.inspector": UiServices["inspector"];
    "ui.status": UiServices["status"];
    "ui.slots": UiServices["slots"];
  }
}
