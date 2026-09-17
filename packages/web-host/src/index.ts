export { createWebHost, installPlugins, type WebHost } from "./boot.js";
export { createUiServices, type UiServices } from "./services/registries.js";
export {
  NavRegistry,
  CommandRegistry,
  RouteRegistry,
  InspectorRegistry,
  StatusRegistry,
  SlotRegistry,
} from "./services/registries.js";
export { WebHostProvider, useWebHost, Slot, Outlet } from "./react/host-context.js";
export { uiServicesPlugin } from "./plugins/ui-services.js";
export type {
  NavItem,
  CommandContribution,
  RouteContribution,
  InspectorContribution,
  StatusItem,
  SlotName,
} from "./types.js";
export type { Context } from "cordis";
