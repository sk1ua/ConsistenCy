import type { Context, Plugin } from "cordis";
import type { WebHost } from "@consistency/web-host";

/**
 * First-pass plugin: registers the legacy App shell surface into ui.slots
 * and seeds default nav/status contributions. Route rendering still lives
 * in App.tsx under HashRouter until later extraction.
 */
export function createLegacyAppPlugin(host: WebHost): Plugin.Function<void> {
  const legacyAppPlugin: Plugin.Function<void> = function legacyAppPlugin(ctx: Context): void {
    const disposeNav = [
      host.ui.nav.register({ id: "inbox", to: "/inbox", label: "Inbox", icon: "inbox", order: 10, section: "Workspace" }),
      host.ui.nav.register({ id: "repositories", to: "/repositories", label: "Repositories", icon: "folder-git", order: 20, section: "Workspace" }),
      host.ui.nav.register({ id: "runs", to: "/runs", label: "Runs", icon: "play", order: 30, section: "Reviews" }),
      host.ui.nav.register({ id: "findings", to: "/findings", label: "Findings", icon: "shield", order: 40, section: "Reviews" }),
      host.ui.nav.register({ id: "workflows", to: "/workflows", label: "Workflows", icon: "git-fork", order: 50, section: "Harness" }),
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
