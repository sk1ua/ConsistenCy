import type { Context, Plugin } from "cordis";
import type { WebHost } from "@consistency/web-host";

/**
 * Shell plugin: documents the agent-desktop shell contribution surface.
 * Visual chrome remains in AppShell.tsx; this plugin owns registry metadata
 * for sidebar/status extension points.
 */
export function createShellPlugin(host: WebHost): Plugin.Function<void> {
  const shellPlugin: Plugin.Function<void> = function shellPlugin(ctx: Context): void {
    const dispose = host.ui.status.register({
      id: "shell",
      label: "Agent desktop",
      tone: "neutral",
      order: 5,
    });
    ctx.effect(() => () => dispose());
  };
  return shellPlugin;
}
