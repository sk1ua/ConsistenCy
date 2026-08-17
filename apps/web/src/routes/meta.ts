import type { Locale } from "../i18n";

export type RouteMeta = {
  title: string;
  shortTitle: string;
  description: string;
  section: string;
};

const en = {
  inbox: { title: "Review inbox", shortTitle: "Inbox", description: "Evidence-backed signals across active pull requests", section: "Workspace" },
  repositories: { title: "Repositories", shortTitle: "Repositories", description: "Observed review sources and live local repository monitors", section: "Workspace" },
  runs: { title: "Audit runs", shortTitle: "Runs", description: "Track every review from intake to decision", section: "Reviews" },
  reports: { title: "Run workbench", shortTitle: "Run", description: "Inspect findings, evidence, and agent decisions", section: "Reviews" },
  findings: { title: "Findings", shortTitle: "Findings", description: "Triage report findings without treating risk as ground truth", section: "Reviews" },
  automations: { title: "Automations", shortTitle: "Automations", description: "Schedule repository checks when the automation service is available", section: "Harness" },
  workflows: { title: "Workflow builder", shortTitle: "Workflows", description: "Visualize and edit deterministic analysis workflows", section: "Harness" },
  settings: { title: "System status", shortTitle: "Settings", description: "Runtime readiness without exposing secret values", section: "System" }
} satisfies Record<string, RouteMeta>;

const zh: typeof en = {
  inbox: { title: "审查收件箱", shortTitle: "收件箱", description: "查看活跃拉取请求中有证据支撑的信号", section: "工作区" },
  repositories: { title: "仓库", shortTitle: "仓库", description: "查看审查来源与实时本地仓库监控", section: "工作区" },
  runs: { title: "审计运行", shortTitle: "运行", description: "跟踪从接收到决策的每次审查", section: "审查" },
  reports: { title: "运行工作台", shortTitle: "运行", description: "检查发现、证据与智能体结论", section: "审查" },
  findings: { title: "发现", shortTitle: "发现", description: "分流报告发现，不把风险信号当作事实", section: "审查" },
  automations: { title: "自动化", shortTitle: "自动化", description: "自动化服务可用后，在这里安排仓库检查", section: "Harness" },
  workflows: { title: "工作流构建器", shortTitle: "工作流", description: "查看和编辑确定性分析工作流", section: "Harness" },
  settings: { title: "系统状态", shortTitle: "设置", description: "在不暴露秘密值的前提下检查运行状态", section: "系统" }
};

export function routeMeta(pathname: string, locale: Locale): RouteMeta {
  const copy = locale === "zh-CN" ? zh : en;
  if (pathname.startsWith("/repositories")) return copy.repositories;
  if (pathname.startsWith("/runs/") || pathname.startsWith("/reports")) return copy.reports;
  if (pathname.startsWith("/runs") || pathname.startsWith("/jobs")) return copy.runs;
  if (pathname.startsWith("/findings")) return copy.findings;
  if (pathname.startsWith("/automations")) return copy.automations;
  if (pathname.startsWith("/workflows")) return copy.workflows;
  if (pathname.startsWith("/settings")) return copy.settings;
  return copy.inbox;
}
