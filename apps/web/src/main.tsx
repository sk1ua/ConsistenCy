import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { createWebHost, installPlugins, WebHostProvider, uiServicesPlugin } from "@consistency/web-host";
import { setExternalUrlOpener } from "@consistency/ui";
import { App } from "./App";
import { openExternalUrl } from "./desktop";
import { createLegacyAppPlugin, createShellPlugin } from "./host";
import { I18nProvider } from "./i18n";
import { workspaceQueryClient } from "./query/client";
import { ThemeProvider } from "./theme";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./styles.css";
import "./design-system/design-system.css";
import "./workspace-enhancements.css";
import "./settings-guidance.css";
import "./notebook-dialog.css";
import "./styles/heartbeat.css";
import "./styles/workflow.css";
import "./styles/diff.css";
import "./styles/motion.css";
import "./styles/workbench-shell.css";
import "./styles/pages-workspace.css";
import "./styles/pages-xray.css";
import "./styles/agent-desktop.css";

setExternalUrlOpener(openExternalUrl);

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root element");
}

const host = createWebHost();
installPlugins(host, [
  uiServicesPlugin,
  createLegacyAppPlugin(host),
  createShellPlugin(host),
]);

createRoot(root).render(
  <React.StrictMode>
    <WebHostProvider host={host}>
      <ThemeProvider>
        <I18nProvider>
          <QueryClientProvider client={workspaceQueryClient}>
            <HashRouter>
              <App />
            </HashRouter>
          </QueryClientProvider>
        </I18nProvider>
      </ThemeProvider>
    </WebHostProvider>
  </React.StrictMode>
);
