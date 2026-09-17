import type { ReactNode } from "react";

export type NavItem = {
  id: string;
  to: string;
  label: string;
  icon?: string;
  order?: number;
  section?: string;
};

export type CommandContribution = {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void | Promise<void>;
};

export type RouteContribution = {
  id: string;
  path: string;
  title?: string;
  element?: ReactNode;
};

export type InspectorContribution = {
  id: string;
  title: string;
  render: () => ReactNode;
};

export type StatusItem = {
  id: string;
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  order?: number;
};

export type SlotName = "shell" | "sidebar" | "workspace" | "inspector" | "status" | "legacy";
