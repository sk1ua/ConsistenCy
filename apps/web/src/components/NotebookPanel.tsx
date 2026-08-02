import type { Notebook, NotebookCardKind, NotebookMessage } from "@consistency/schema";
import { Bot, Braces, Download, FileCode2, LoaderCircle, Send, Sparkles, Wrench } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type NotebookStreamEvent } from "../api/client";
import { useI18n } from "../i18n";

const cardKinds: Array<{ kind: NotebookCardKind; label: string }> = [
  { kind: "change_map", label: "Change Map" },
  { kind: "architecture_impact", label: "Architecture Impact" },
  { kind: "risk_brief", label: "Risk Brief" },
  { kind: "fix_plan", label: "Fix Plan" }
];

type CitationLike = { file: string; startLine: number; endLine: number; headSha: string };

function eventText(event: NotebookStreamEvent, t: (key: string) => string): string | undefined {
  if (event.event === "tool.started") return `${t("tool started")} · ${String((event.data as { tool?: unknown }).tool ?? "unknown")}`;
  if (event.event === "tool.result") return `${t("tool result")} · ${String((event.data as { tool?: unknown }).tool ?? "unknown")}`;
  if (event.event === "source.selected") return `${t("source selected")} · ${String((event.data as { headSha?: unknown }).headSha ?? "sha")}`;
  if (event.event === "run.degraded") return `${t("degraded")} · ${String((event.data as { reason?: unknown }).reason ?? t("LLM unavailable"))}`;
  return undefined;
}

function citationKey(citation: CitationLike): string {
  return `${citation.file}:${citation.startLine}-${citation.endLine}:${citation.headSha}`;
}

function downloadCard(card: Notebook["cards"][number]): void {
  const blob = new Blob([card.content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${card.kind}-${card.id}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatRole(role: string, t: (key: string) => string): string {
  switch (role) {
    case "user":
    case "User":
      return t("user");
    case "assistant":
    case "Assistant":
      return t("assistant");
    case "system":
    case "System":
      return t("system");
    default:
      return t(role);
  }
}

function formatStatus(status: string, t: (key: string) => string): string {
  switch (status) {
    case "completed":
    case "Completed":
      return t("completed");
    case "streaming":
    case "Streaming":
      return t("streaming");
    case "pending":
    case "Pending":
      return t("pending");
    default:
      return t(status);
  }
}

function MessageBubble({ message }: { message: NotebookMessage }) {
  const { t } = useI18n();
  return <div className={`notebook-message ${message.role}`}>
    <div className="notebook-message-head">
      <span>{message.role === "assistant" ? <Bot size={13} /> : <Braces size={13} />}{formatRole(message.role, t)}</span>
      <small>{formatStatus(message.status, t)}</small>
    </div>
    <div className="notebook-message-content">{message.content || <span className="stream-placeholder">{t("Generating grounded response…")}</span>}</div>
    {message.citations.length > 0 && <div className="notebook-citations">{message.citations.map(citation => <span key={citationKey(citation)}><FileCode2 size={11} />{citation.file}:{citation.startLine}-{citation.endLine}</span>)}</div>}
  </div>;
}

export function NotebookPanel({ notebookId }: { notebookId?: string }) {
  const { t } = useI18n();
  const [notebook, setNotebook] = useState<Notebook>();
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState<NotebookMessage>();
  const [events, setEvents] = useState<string[]>([]);
  const [cardLoading, setCardLoading] = useState<NotebookCardKind>();
  const [error, setError] = useState<string>();

  async function refresh() {
    if (!notebookId) return;
    try {
      const loaded = await api.notebook(notebookId);
      setNotebook(loaded);
      setSelectedSources(current => current.length > 0 ? current.filter(id => loaded.sources.some(source => source.jobId === id)) : loaded.sources.slice(-1).map(source => source.jobId));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Notebook unavailable"));
    }
  }

  useEffect(() => {
    setNotebook(undefined);
    setDraft(undefined);
    setEvents([]);
    void refresh();
  }, [notebookId]);

  const messages = useMemo(() => [...(notebook?.messages ?? []), ...(draft ? [draft] : [])], [notebook?.messages, draft]);
  const latestRun = [...messages].reverse().find(message => message.role === "assistant" && message.provider);
  const usageLabel = latestRun?.tokenUsage?.totalTokens !== undefined
    ? `${latestRun.tokenUsage.totalTokens} ${t("tokens")}`
    : t("usage unavailable");

  async function ask(event: FormEvent) {
    event.preventDefault();
    const content = question.trim();
    if (!notebookId || !content || streaming || selectedSources.length === 0) return;
    setQuestion("");
    setStreaming(true);
    setEvents([]);
    setError(undefined);
    setDraft({ id: "draft", notebookId, role: "assistant", content: "", status: "streaming", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceJobIds: selectedSources, citations: [] });
    try {
      for await (const eventItem of api.streamNotebookMessage(notebookId, content, selectedSources)) {
        const text = eventItem.event === "text.delta" ? String((eventItem.data as { text?: unknown }).text ?? "") : undefined;
        if (text) setDraft(current => current ? { ...current, content: current.content + text } : current);
        const log = eventText(eventItem, t);
        if (log) setEvents(current => [...current.slice(-5), log]);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Notebook stream failed"));
    } finally {
      setDraft(undefined);
      setStreaming(false);
    }
  }

  async function generateCard(kind: NotebookCardKind) {
    if (!notebookId || selectedSources.length === 0 || cardLoading) return;
    setCardLoading(kind);
    setError(undefined);
    try {
      for await (const eventItem of api.streamNotebookCard(notebookId, kind, selectedSources)) {
        const log = eventText(eventItem, t);
        if (log) setEvents(current => [...current.slice(-5), log]);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Card generation failed"));
    } finally {
      setCardLoading(undefined);
    }
  }

  if (!notebookId) return <section className="notebook-panel notebook-empty">
    <div className="notebook-panel-title"><div><span className="panel-kicker">{t("Repository notebook")}</span><h2>{t("Evidence workspace")}</h2></div><Sparkles size={18} /></div>
    <p>{t("Analyze a public GitHub PR to open a SHA-bound Notebook beside its report. The Notebook can read, explain and suggest patches without changing the workspace.")}</p>
  </section>;

  return <section className="notebook-panel">
    <div className="notebook-panel-title"><div><span className="panel-kicker">{t("Repository notebook")}</span><h2>{t("Research space")}</h2></div><div className="notebook-panel-status"><span className="notebook-state"><i />{notebook?.sources.some(source => source.indexStatus === "ready") ? t("Indexed") : t("Preparing")}</span>{latestRun && <small>{latestRun.provider} / {latestRun.model ?? t("model unavailable")} · {usageLabel}</small>}</div></div>
    {notebook && <>
      <div className="notebook-source-bar"><div><span>{t("Repository")}</span><strong>{notebook.repository}</strong></div><label><span>{t("Sources")}</span><select aria-label={t("Notebook sources")} multiple value={selectedSources} onChange={event => setSelectedSources(Array.from(event.target.selectedOptions, option => option.value))}>{notebook.sources.map(source => <option key={source.jobId} value={source.jobId}>PR #{source.pullRequestNumber} · {source.headSha.slice(0, 10)}</option>)}</select></label></div>
      <div className="notebook-cards">{cardKinds.map(({ kind, label }) => <button type="button" className="notebook-card-trigger" key={kind} disabled={Boolean(cardLoading) || selectedSources.length === 0} onClick={() => void generateCard(kind)}><span>{t(label)}</span>{cardLoading === kind ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />}</button>)}</div>
      {notebook.cards.length > 0 && <div className="notebook-card-list">{notebook.cards.slice(0, 4).map(card => <article className="notebook-card" key={card.id}><div><strong>{card.title}</strong><span className={`badge badge-${card.status}`}>{t(card.status === "generated" ? "Generated" : card.status === "degraded" ? "Degraded" : card.status)}</span></div><p>{card.content}</p><div className="notebook-card-footer">{card.citations.length > 0 && <small>{t("{count} source citations", { count: card.citations.length })}</small>}{card.kind === "fix_plan" && <button type="button" className="notebook-download" onClick={() => downloadCard(card)}><Download size={12} /> {t("Download suggestion")}</button>}</div></article>)}</div>}
      <div className="notebook-stream-head"><span><Wrench size={13} /> {t("Agent trace")}</span><small>{events.length ? events.slice(-5).map((ev, i) => <span key={i} className="trace-event">{ev}{i < Math.min(events.length, 5) - 1 ? " · " : ""}</span>) : t("Tools stay read-only and source-bound.")}</small></div>
      <div className="notebook-messages">{messages.length === 0 ? <div className="notebook-placeholder">{t("Ask why this PR changed these modules, which files carry the most risk, or what a safe fix plan would look like.")}</div> : messages.slice(-8).map(message => <MessageBubble message={message} key={message.id} />)}</div>
      <form className="notebook-composer" onSubmit={event => void ask(event)}><textarea aria-label={t("Ask Repository Notebook")} value={question} onChange={event => setQuestion(event.target.value)} placeholder={t("Ask about the selected PR and SHA…")} disabled={streaming} /><button type="submit" aria-label={t("Send question")} disabled={streaming || !question.trim() || selectedSources.length === 0}>{streaming ? <LoaderCircle className="spinning" size={16} /> : <Send size={16} />}</button></form>
      {error && <div className="notebook-error">{error}</div>}
    </>}
  </section>;
}
