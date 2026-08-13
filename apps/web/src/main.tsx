import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./theme";
import "./styles.css";
import "./workspace-enhancements.css";
import "./settings-guidance.css";
import "./notebook-dialog.css";
import "./styles/heartbeat.css";
import "./styles/workflow.css";
import "./styles/diff.css";
import "./styles/motion.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider><I18nProvider><App /></I18nProvider></ThemeProvider>
  </React.StrictMode>
);
