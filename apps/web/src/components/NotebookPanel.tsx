import type { Notebook, NotebookCardKind, NotebookMessage } from "@consistency/schema";
import { Bot, Braces, Download, FileCode2, Layers, LoaderCircle, Send, ShieldAlert, Sparkles, Workflow, Wrench } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type WheelEvent as ReactWheelEvent } from "react";
import { api, type NotebookStreamEvent } from "../api/client";
import { useI18n } from "../i18n";
import { MarkdownContent } from "./MarkdownContent";

const cardKinds: Array<{ kind: NotebookCardKind; label: string; icon: typeof FileCode2 }> = [
  { kind: "risk_brief", label: "解释高风险变更", icon: ShieldAlert },
  { kind: "change_map", label: "生成变更地图", icon: Layers },
  { kind: "architecture_impact", label: "总结架构影响", icon: Workflow },
  { kind: "fix_plan", label: "建议修复方案", icon: FileCode2 }
];

type CitationLike = { file: string; startLine: number; endLine: number; headSha: string };

function eventText(event: NotebookStreamEvent, zh: boolean): string | undefined {
  if (event.event === "tool.started") return `${zh ? "工具已启动" : "tool started"} · ${String((event.data as { tool?: unknown }).tool ?? "unknown")}`;
  if (event.event === "tool.result") return `${zh ? "工具结果" : "tool result"} · ${String((event.data as { tool?: unknown }).tool ?? "unknown")}`;
  if (event.event === "source.selected") return `${zh ? "来源已选择" : "source selected"} · ${String((event.data as { headSha?: unknown }).headSha ?? "sha")}`;
  if (event.event === "run.degraded") return `${zh ? "已降级" : "degraded"} · ${String((event.data as { reason?: unknown }).reason ?? (zh ? "LLM 不可用" : "LLM unavailable"))}`;
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

function formatRole(role: string, zh: boolean): string {
  switch (role.toLowerCase()) {
    case "user": return zh ? "用户" : "User";
    case "assistant": return zh ? "智能体" : "Assistant";
    case "system": return zh ? "系统" : "System";
    default: return role;
  }
}

function formatStatus(status: string, zh: boolean): string {
  switch (status.toLowerCase()) {
    case "completed": return zh ? "已完成" : "Completed";
    case "streaming": return zh ? "生成中" : "Streaming";
    case "pending": return zh ? "排队中" : "Pending";
    default: return status;
  }
}

function MessageBubble({ message, zh }: { message: NotebookMessage; zh: boolean }) {
  const deferredContent = useDeferredValue(message.content);
  return (
    <div className={`notebook-message ${message.role}`}>
      <div className="notebook-message-head">
        <span>{message.role === "assistant" ? <Bot size={13} /> : <Braces size={13} />}{formatRole(message.role, zh)}</span>
        <small>{formatStatus(message.status, zh)}</small>
      </div>
      {message.content ? (
        message.role === "assistant" ? (
          <MarkdownContent content={deferredContent} className="notebook-message-content notebook-markdown" />
        ) : (
          <div className="notebook-message-content">{message.content}</div>
        )
      ) : (
        <div className="notebook-message-content">
          <span className="stream-placeholder">{zh ? "正在生成基于证据的回答…" : "Generating grounded response…"}</span>
        </div>
      )}
      {message.citations.length > 0 && (
        <div className="notebook-citations">
          {message.citations.map(citation => (
            <span key={citationKey(citation)}><FileCode2 size={11} />{citation.file}:{citation.startLine}-{citation.endLine}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function NotebookPanel({ notebookId }: { notebookId?: string }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";

  const railRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const refreshAbortRef = useRef<AbortController | undefined>(undefined);
  const streamAbortRef = useRef<AbortController | undefined>(undefined);
  const cardAbortRef = useRef<AbortController | undefined>(undefined);

  const [notebook, setNotebook] = useState<Notebook>();
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState<NotebookMessage>();
  const [events, setEvents] = useState<string[]>([]);
  const [cardLoading, setCardLoading] = useState<NotebookCardKind>();
  const [error, setError] = useState<string>();

  async function refresh(signal?: AbortSignal) {
    if (!notebookId) return;
    try {
      const loaded = await api.notebook(notebookId, signal);
      if (signal?.aborted) return;
      setNotebook(loaded);
      setSelectedSources(current => current.length > 0 ? current.filter(id => loaded.sources.some(source => source.jobId === id)) : loaded.sources.slice(-1).map(source => source.jobId));
      setError(undefined);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : (zh ? "笔记本不可用" : "Notebook unavailable"));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    refreshAbortRef.current?.abort();
    streamAbortRef.current?.abort();
    cardAbortRef.current?.abort();
    refreshAbortRef.current = controller;
    setNotebook(undefined);
    setDraft(undefined);
    setEvents([]);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [notebookId]);

  useEffect(() => () => {
    refreshAbortRef.current?.abort();
    streamAbortRef.current?.abort();
    cardAbortRef.current?.abort();
  }, []);

  const messages = useMemo(() => [...(notebook?.messages ?? []), ...(draft ? [draft] : [])], [notebook?.messages, draft]);
  const latestRun = [...messages].reverse().find(message => message.role === "assistant" && message.provider);
  const usageLabel = latestRun?.tokenUsage?.totalTokens !== undefined
    ? `${latestRun.tokenUsage.totalTokens} ${zh ? "个令牌" : "tokens"}`
    : (zh ? "用量待记录" : "usage pending");

  async function ask(event: FormEvent) {
    event.preventDefault();
    const content = question.trim();
    if (!notebookId || !content || streaming || selectedSources.length === 0) return;
    setQuestion("");
    setStreaming(true);
    setEvents([]);
    setError(undefined);
    setDraft({
      id: "draft",
      notebookId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceJobIds: selectedSources,
      citations: []
    });
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    try {
      for await (const eventItem of api.streamNotebookMessage(notebookId, content, selectedSources, controller.signal)) {
        const text = eventItem.event === "text.delta" ? String((eventItem.data as { text?: unknown }).text ?? "") : undefined;
        if (text) setDraft(current => current ? { ...current, content: current.content + text } : current);
        const log = eventText(eventItem, zh);
        if (log) setEvents(current => [...current.slice(-5), log]);
      }
      await refresh(controller.signal);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : (zh ? "流式回答生成失败" : "Notebook stream failed"));
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = undefined;
        setDraft(undefined);
        setStreaming(false);
      }
    }
  }

  function handleMessagesWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const messagesEl = messagesRef.current;
    const railEl = railRef.current;
    if (!messagesEl || !railEl) return;
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 4;
    const atTop = messagesEl.scrollTop <= 0;
    if (atBottom && event.deltaY > 0 && railEl.scrollHeight > railEl.clientHeight) {
      railEl.scrollTop = Math.min(railEl.scrollTop + event.deltaY, railEl.scrollHeight - railEl.clientHeight);
      event.preventDefault();
    } else if (atTop && event.deltaY < 0 && railEl.scrollTop > 0) {
      railEl.scrollTop = Math.max(railEl.scrollTop + event.deltaY, 0);
      event.preventDefault();
    }
  }

  async function generateCard(kind: NotebookCardKind) {
    if (!notebookId || selectedSources.length === 0 || cardLoading) return;
    setCardLoading(kind);
    setError(undefined);
    const controller = new AbortController();
    cardAbortRef.current?.abort();
    cardAbortRef.current = controller;
    try {
      for await (const eventItem of api.streamNotebookCard(notebookId, kind, selectedSources, controller.signal)) {
        const log = eventText(eventItem, zh);
        if (log) setEvents(current => [...current.slice(-5), log]);
      }
      await refresh(controller.signal);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : (zh ? "分析卡片生成失败" : "Card generation failed"));
    } finally {
      if (cardAbortRef.current === controller) {
        cardAbortRef.current = undefined;
        setCardLoading(undefined);
      }
    }
  }

  if (!notebookId) {
    return (
      <section className="notebook-panel notebook-empty">
        <div className="notebook-panel-title">
          <div>
            <span className="panel-kicker">{zh ? "审查笔记本" : "Review Notebook"}</span>
            <h2>{zh ? "笔记本" : "Notebook"}</h2>
          </div>
          <Sparkles size={18} />
        </div>
        <p>{zh ? "分析公开 GitHub PR 或本地仓库，在审查旁打开基于代码事实的笔记本，可解释代码并建议补丁。" : "Analyze a PR to open a SHA-bound Notebook. It reads and explains code without modifying the workspace."}</p>
      </section>
    );
  }

  return (
    <section className="notebook-panel notebook-canvas page-stack">
      {/* 1. Header */}
      <div className="notebook-panel-title">
        <div>
          <span className="panel-kicker">{zh ? "审查笔记本" : "Review Notebook"}</span>
          <h2>{zh ? "笔记本" : "Notebook"}</h2>
        </div>
        <div className="notebook-panel-status">
          <span className="notebook-state">
            <i />{notebook?.sources.some(s => s.indexStatus === "ready") ? (zh ? "已索引" : "Indexed") : (zh ? "准备中" : "Preparing")}
          </span>
          {latestRun && (
            <small>{latestRun.provider === "mock" ? (zh ? "Mock 模型" : "Mock model") : latestRun.provider} · {usageLabel}</small>
          )}
        </div>
      </div>

      {notebook && (
        <>
          {/* Trust strip */}
          <div className="notebook-trust-strip">
            <strong>{zh ? "LLM 理解审查任务" : "LLM interprets the task"}</strong>
            <span aria-hidden="true">→</span>
            <strong>{zh ? "只读工具检索代码事实" : "read-only tools gather evidence"}</strong>
            <span aria-hidden="true">→</span>
            <strong>{zh ? "精确引用保障结论可查" : "citations keep claims reviewable"}</strong>
          </div>

          <div className="notebook-layout">
            {/* Left Rail: Sources & Action Cards */}
            <aside className="notebook-rail" ref={railRef}>
              <div className="notebook-source-bar">
                <div>
                  <span>{zh ? "代码仓库" : "Repository"}</span>
                  <strong>{notebook.repository}</strong>
                </div>
                <label>
                  <span>{zh ? "绑定来源" : "Sources"}</span>
                  <select
                    aria-label={zh ? "笔记本来源" : "Notebook sources"}
                    multiple
                    value={selectedSources}
                    onChange={event => setSelectedSources(Array.from(event.target.selectedOptions, option => option.value))}
                  >
                    {notebook.sources.map(source => {
                      const isDemo = source.headSha.startsWith("demo-") || source.jobId.startsWith("job_demo");
                      return (
                        <option key={source.jobId} value={source.jobId}>
                          {source.pullRequestNumber === undefined ? (zh ? "本地" : "Local") : `PR #${source.pullRequestNumber}`} · {isDemo ? (zh ? "FIXTURE" : "FIXTURE") : source.headSha.slice(0, 8)}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>

              {/* Action Buttons */}
              <div className="notebook-cards">
                {cardKinds.map(({ kind, label, icon: Icon }) => (
                  <button
                    type="button"
                    className="notebook-card-trigger"
                    key={kind}
                    disabled={Boolean(cardLoading) || selectedSources.length === 0}
                    onClick={() => void generateCard(kind)}
                  >
                    <Icon size={13} />
                    <span>{t(label)}</span>
                    {cardLoading === kind ? <LoaderCircle className="spinning" size={13} /> : <Sparkles size={13} />}
                  </button>
                ))}
              </div>

              {/* Generated Cards List */}
              {notebook.cards.length > 0 && (
                <div className="notebook-card-list">
                  {notebook.cards.slice(0, 4).map(card => (
                    <article className="notebook-card" key={card.id}>
                      <div className="notebook-card-head">
                        <strong>{card.title}</strong>
                        <span className={`badge badge-${card.status}`}>{t(card.status === "generated" ? "Generated" : card.status === "degraded" ? "Degraded" : card.status)}</span>
                      </div>
                      <MarkdownContent content={card.content} className="notebook-card-content notebook-markdown" />
                      <div className="notebook-card-footer">
                        {card.citations.length > 0 && <small>{t("{count} source citations", { count: card.citations.length })}</small>}
                        {card.kind === "fix_plan" && (
                          <button type="button" className="notebook-download" onClick={() => downloadCard(card)}>
                            <Download size={12} /> {t("Download suggestion")}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </aside>

            {/* Right: Stream Conversation & Always-Obvious Composer */}
            <div className="notebook-conversation">
              <div className="notebook-stream-head">
                <span><Wrench size={13} /> {zh ? "智能体执行追踪" : "Agent trace"}</span>
                <small>{events.length ? events.slice(-5).join(" · ") : (zh ? "工具严格只读且绑定源提交。" : "Tools stay read-only and source-bound.")}</small>
              </div>

              <div className="notebook-messages" ref={messagesRef} onWheel={handleMessagesWheel}>
                {messages.length === 0 ? (
                  <div className="notebook-placeholder-compact">
                    <p>{zh ? "基于本次审查的代码、差异与证据继续追问。" : "Ask evidence-grounded questions about this review."}</p>
                    <div className="notebook-starters-compact">
                      <button type="button" onClick={() => setQuestion(zh ? "解释本次审查中风险最高的核心变更与成因。" : "Explain the highest-risk changes and their causes.")}>
                        <FileCode2 size={13} /> {zh ? "解释高风险变更" : "Explain high-risk changes"}
                      </button>
                      <button type="button" onClick={() => setQuestion(zh ? "总结本次变更对系统架构与依赖关系的影响。" : "Summarize architecture impact.")}>
                        <Workflow size={13} /> {zh ? "总结架构影响" : "Summarize architecture impact"}
                      </button>
                    </div>
                  </div>
                ) : (
                  messages.slice(-12).map(message => <MessageBubble message={message} zh={zh} key={message.id} />)
                )}
              </div>

              {/* Obvious Composer Input Box */}
              <form className="notebook-composer-form" onSubmit={event => void ask(event)}>
                <input
                  type="text"
                  aria-label={zh ? "询问本次审查" : "Ask about this review"}
                  value={question}
                  onChange={event => setQuestion(event.target.value)}
                  placeholder={zh ? "询问本次审查（如：解释高风险改动、验证建议）…" : "Ask about this review (e.g. explain risk, suggested fixes)…"}
                  disabled={streaming}
                />
                <button
                  type="submit"
                  aria-label={zh ? "发送问题" : "Send question"}
                  disabled={streaming || !question.trim() || selectedSources.length === 0}
                  className="primary-button btn-small"
                >
                  {streaming ? <LoaderCircle className="spinning" size={14} /> : <Send size={14} />}
                  <span>{zh ? "发送" : "Send"}</span>
                </button>
              </form>
              {error && <div className="notebook-error">{error}</div>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
