import type { HealthResponse } from "../api/client";
import { CheckCircle2, Database, Github, KeyRound, ServerCog, XCircle } from "lucide-react";

function ConfigRow({ icon: Icon, label, value, ok }: { icon: typeof Github; label: string; value: string; ok?: boolean }) {
  return <div className="config-row"><Icon size={18} /><span><strong>{label}</strong><small>{value}</small></span>{ok === undefined ? null : ok ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="bad" size={18} />}</div>;
}

export function SettingsPage({ health }: { health?: HealthResponse }) {
  if (!health) return <div className="empty-state">Configuration status is unavailable in offline Demo Mode.</div>;
  return <section className="section-block settings-page">
    <div className="section-heading"><div><h2>Runtime configuration</h2><p>Presence and status only. Secret values are never returned.</p></div></div>
    <div className="config-list">
      <ConfigRow icon={Github} label="GitHub App" value={health.configuration.githubAppConfigured ? "Configured" : "Not configured"} ok={health.configuration.githubAppConfigured} />
      <ConfigRow icon={KeyRound} label="Webhook secret" value={health.configuration.webhookSecretConfigured ? "Configured" : "Not configured"} ok={health.configuration.webhookSecretConfigured} />
      <ConfigRow icon={ServerCog} label="LLM provider" value={health.llmProvider} />
      <ConfigRow icon={ServerCog} label="Worker" value={`${health.worker.running ? "Running" : "Stopped"} · concurrency ${health.worker.concurrency}`} ok={health.worker.running} />
      <ConfigRow icon={Database} label="Database" value={health.configuration.databasePath} ok={health.database.ok} />
    </div>
  </section>;
}
