import type { Context, Plugin } from "cordis";
import type { WebHost } from "@consistency/web-host";

/**
 * First-pass plugin: registers the legacy App shell surface into ui.slots
 * and seeds default nav/status contributions. Route rendering still lives
 * in App.tsx under HashRouter until later extraction.
 *
 * Locked IA (feat/web-cordis-agent-desktop): primary left entries are
 * Automation + Plugin marketplace + connected repos. Cross-cutting
 * Inbox/Runs/Findings/Studio remain reachable via Cmd+K / deep links,
 * not as peer primary nav spam.
 */
export function createLegacyAppPlugin(host: WebHost): Plugin.Function<void> {
  const legacyAppPlugin: Plugin.Function<void> = function legacyAppPlugin(ctx: Context): void {
    const disposeNav = [
      host.ui.nav.register({ id: "workbench", to: "/inbox", label: "Workbench", icon: "folder-git", order: 10, section: "Workspace" }),
      host.ui.nav.register({ id: "automation", to: "/automation", label: "Automation", icon: "zap", order: 20, section: "Workspace" }),
      host.ui.nav.register({ id: "plugins", to: "/plugins", label: "Plugins", icon: "puzzle", order: 30, section: "Workspace" }),
      host.ui.nav.register({ id: "repositories", to: "/repositories", label: "Repositories", icon: "folder-git", order: 40, section: "Workspace" }),
      host.ui.nav.register({ id: "workflows", to: "/workflows", label: "Workflows", icon: "git-fork", order: 90, section: "Advanced" }),
      host.ui.nav.register({ id: "runs", to: "/runs", label: "Runs", icon: "play", order: 100, section: "Advanced" }),
      host.ui.nav.register({ id: "findings", to: "/findings", label: "Findings", icon: "shield", order: 110, section: "Advanced" }),
    ];
    const disposeStatus = host.ui.status.register({
      id: "host",
      label: "Cordis host",
      tone: "success",
      order: 0,
    });
    ctx.effect(() => () => {
      for (const dispose of disposeNav) dispose();
      disposeStatus();
    });
    // Mark that the legacy surface is installed (App mounts via React tree).
    host.ui.slots.set("legacy", null);
  };
  return legacyAppPlugin;
}
