import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
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

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={workspaceQueryClient}>
          <HashRouter><App /></HashRouter>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
);
