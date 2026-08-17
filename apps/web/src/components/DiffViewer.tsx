import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReviewFinding, Severity, VcsChangedFile } from "@consistency/schema";
import { FileCode2, GitMerge } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref
} from "react";
import { useI18n } from "../i18n";
import {
  buildFindingIndex,
  findingsForFile,
  findingsForLine,
  type FindingIndex
} from "./diffFindingIndex";
import { StatusBadge } from "./StatusBadge";

type Row = {
  type: "context" | "add" | "del" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
};

type DiffMode = "unified" | "split";

const VIRTUALIZE_AFTER_ROWS = 220;
const SEVERITY_PRIORITY: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

function rowsFor(hunk: VcsChangedFile["hunks"][number]): Row[] {
  const rows: Row[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const raw of hunk.content.split("\n")) {
    if (raw === "") continue;
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === " ") {
      rows.push({ type: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    } else if (marker === "-") {
      rows.push({ type: "del", oldLine, text });
      oldLine += 1;
    } else if (marker === "+") {
      rows.push({ type: "add", newLine, text });
      newLine += 1;
    } else {
      rows.push({ type: "meta", text: raw });
    }
  }
  return rows;
}

function statusLabel(status: VcsChangedFile["status"]): string {
  switch (status) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "untracked": return "U";
    case "type_changed": return "T";
  }
}

function lineLabel(finding: ReviewFinding): string {
  if (finding.startLine === undefined) return "file";
  return finding.startLine === finding.endLine
    ? `L${finding.startLine}`
    : `L${finding.startLine}-${finding.endLine}`;
}

function findingsForRow(index: FindingIndex, file: string, row: Row): ReviewFinding[] {
  const unique = new Map<string, ReviewFinding>();
  for (const finding of findingsForLine(index, file, row.newLine)) unique.set(finding.id, finding);
  if (row.type === "del") {
    for (const finding of findingsForLine(index, file, row.oldLine)) unique.set(finding.id, finding);
  }
  return [...unique.values()];
}

function strongestSeverity(findings: readonly ReviewFinding[]): Severity | undefined {
  let strongest: Severity | undefined;
  for (const finding of findings) {
    if (!strongest || SEVERITY_PRIORITY[finding.severity] > SEVERITY_PRIORITY[strongest]) strongest = finding.severity;
  }
  return strongest;
}

function activeCoordinate(row: Row): number | undefined {
  return row.newLine ?? row.oldLine;
}

function DiffRowButton({
  row,
  path,
  findingIndex,
  activeLine,
  onActiveLine,
  rowRef,
  style,
  dataIndex,
  mode
}: {
  row: Row;
  path: string;
  findingIndex: FindingIndex;
  activeLine?: number;
  onActiveLine: (line?: number) => void;
  rowRef?: Ref<HTMLButtonElement>;
  style?: CSSProperties;
  dataIndex?: number;
  mode: DiffMode;
}) {
  const rowFindings = findingsForRow(findingIndex, path, row);
  const severity = strongestSeverity(rowFindings);
  const coordinate = activeCoordinate(row);
  const active = coordinate !== undefined && coordinate === activeLine;
  const marker = row.type === "del" ? "-" : row.type === "add" ? "+" : row.type === "context" ? " " : "";

  return <button
    ref={rowRef}
    data-index={dataIndex}
    type="button"
    tabIndex={rowFindings.length > 0 ? 0 : -1}
    style={style}
    className={`diff-row diff-mode-${mode} diff-row-${row.type}${severity ? ` diff-finding diff-finding-${severity}` : ""}${active ? " diff-active" : ""}`}
    aria-label={`${path} ${coordinate === undefined ? "metadata" : `line ${coordinate}`}${rowFindings.length > 0 ? `, ${rowFindings.length} findings` : ""}`}
    aria-expanded={rowFindings.length > 0 ? active : undefined}
    onClick={() => coordinate !== undefined && onActiveLine(active ? undefined : coordinate)}
  >
    {mode === "split" ? <>
      <span className="diff-ln">{row.oldLine ?? ""}</span>
      <span className="diff-code">{row.type === "add" ? "" : row.type === "meta" ? row.text : `${marker}${row.text}`}</span>
      <span className="diff-ln">{row.newLine ?? ""}</span>
      <span className="diff-code">{row.type === "del" || row.type === "meta" ? "" : `${marker}${row.text}`}</span>
    </> : <>
      <span className="diff-ln">{row.oldLine ?? ""}</span>
      <span className="diff-ln">{row.newLine ?? ""}</span>
      <span className="diff-code">{row.type === "meta" ? row.text : `${marker}${row.text}`}</span>
    </>}
    {active && rowFindings.length > 0 ? <span className="diff-popover" role="status">
      {rowFindings.map(finding => <span key={finding.id}><StatusBadge value={finding.severity} /><strong>{finding.title}</strong></span>)}
    </span> : null}
  </button>;
}

function StaticDiffRows({ rows, path, findingIndex, activeLine, onActiveLine, mode }: {
  rows: Row[];
  path: string;
  findingIndex: FindingIndex;
  activeLine?: number;
  onActiveLine: (line?: number) => void;
  mode: DiffMode;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center" });
  }, [activeLine, path]);

  return <div className="diff-grid" tabIndex={0} role="region" aria-label="Code diff">
    {rows.map((row, index) => {
      const coordinate = activeCoordinate(row);
      return <DiffRowButton
        key={`${row.type}-${row.oldLine ?? "o"}-${row.newLine ?? "n"}-${index}`}
        row={row}
        path={path}
        findingIndex={findingIndex}
        activeLine={activeLine}
        onActiveLine={onActiveLine}
        rowRef={coordinate !== undefined && coordinate === activeLine ? activeRef : undefined}
        mode={mode}
      />;
    })}
  </div>;
}

function VirtualDiffRows({ rows, path, findingIndex, activeLine, onActiveLine, mode }: {
  rows: Row[];
  path: string;
  findingIndex: FindingIndex;
  activeLine?: number;
  onActiveLine: (line?: number) => void;
  mode: DiffMode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: index => activeCoordinate(rows[index]!) === activeLine ? 70 : 24,
    initialRect: { width: 900, height: 560 },
    overscan: 18,
    getItemKey: index => `${rows[index]?.type}-${rows[index]?.oldLine ?? "o"}-${rows[index]?.newLine ?? "n"}-${index}`
  });

  useEffect(() => {
    virtualizer.measure();
    if (activeLine === undefined) return;
    const activeIndex = rows.findIndex(row => activeCoordinate(row) === activeLine);
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "center" });
  }, [activeLine, path, rows, virtualizer]);

  return <div className="diff-code-viewport" ref={viewportRef}>
    <div className="diff-virtual-canvas" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => <DiffRowButton
        key={item.key}
        row={rows[item.index]!}
        path={path}
        findingIndex={findingIndex}
        activeLine={activeLine}
        onActiveLine={onActiveLine}
        dataIndex={item.index}
        rowRef={virtualizer.measureElement}
        mode={mode}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
      />)}
    </div>
  </div>;
}

export function DiffViewer({ files, findings, focus }: {
  files: VcsChangedFile[];
  findings: ReviewFinding[];
  focus?: { file: string; line?: number };
}) {
  const { t } = useI18n();
  const [selectedPath, setSelectedPath] = useState<string>(files[0]?.path ?? "");
  const [activeLine, setActiveLine] = useState<number>();
  const [mode, setMode] = useState<DiffMode>("unified");
  const findingIndex = useMemo(() => buildFindingIndex(findings), [findings]);

  useEffect(() => {
    if (files.some(file => file.path === selectedPath)) return;
    setSelectedPath(files[0]?.path ?? "");
    setActiveLine(undefined);
  }, [files, selectedPath]);

  useEffect(() => {
    if (!focus || !files.some(file => file.path === focus.file)) return;
    setSelectedPath(focus.file);
    setActiveLine(focus.line);
  }, [files, focus]);

  const selected = files.find(file => file.path === selectedPath) ?? files[0];
  const rows = useMemo(() => selected ? selected.hunks.flatMap(rowsFor) : [], [selected]);
  const shouldVirtualize = rows.length > VIRTUALIZE_AFTER_ROWS && typeof window !== "undefined";

  if (files.length === 0) {
    return <div className="empty-state"><GitMerge size={22} />{t("No changes to show.")}</div>;
  }

  return <div className="diff-viewer">
    <nav className="diff-file-list" aria-label={t("Changed files")}>
      <h3>{t("Changed files")} <span>{files.length}</span></h3>
      <ul className="diff-tree">
        {files.map(file => {
          const fileFindings = findingsForFile(findingIndex, file.path);
          const active = selected?.path === file.path;
          return <li key={file.path}>
            <button
              type="button"
              className={`diff-tree-file${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-expanded={fileFindings.length > 0 ? active : undefined}
              onClick={() => { setSelectedPath(file.path); setActiveLine(undefined); }}
            >
              <span className={`diff-status diff-status-${file.status}`}>{statusLabel(file.status)}</span>
              <code>{file.path}</code>
              <small>+{file.additions} -{file.deletions}{fileFindings.length > 0 ? ` · ${fileFindings.length}` : ""}</small>
            </button>
            {active && fileFindings.length > 0 ? <ul className="diff-tree-findings" aria-label={`${file.path} ${t("Findings")}`}>
              {fileFindings.map(finding => <li key={finding.id}>
                <button type="button" className="diff-tree-finding" onClick={() => setActiveLine(finding.startLine)}>
                  <StatusBadge value={finding.severity} />
                  <span><strong>{finding.title}</strong><small>{lineLabel(finding)}</small></span>
                </button>
              </li>)}
            </ul> : null}
          </li>;
        })}
      </ul>
    </nav>
    <section className="diff-content" aria-label={selected?.path ?? t("Diff")}>
      {!selected ? <div className="empty-inline">{t("No changes to show.")}</div> : <>
        <div className="diff-file-head">
          <FileCode2 size={16} />
          <strong>{selected.path}</strong>
          <span className={`diff-status diff-status-${selected.status}`}>{statusLabel(selected.status)}</span>
          <div className="diff-mode-toggle" role="group" aria-label={t("Diff view mode")}>
            <button type="button" className={mode === "unified" ? "active" : ""} aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>{t("Unified")}</button>
            <button type="button" className={mode === "split" ? "active" : ""} aria-pressed={mode === "split"} onClick={() => setMode("split")}>{t("Split")}</button>
          </div>
        </div>
        {rows.length === 0 ? <div className="empty-inline">{t("No changes to show.")}</div>
          : shouldVirtualize
            ? <VirtualDiffRows rows={rows} path={selected.path} findingIndex={findingIndex} activeLine={activeLine} onActiveLine={setActiveLine} mode={mode} />
            : <StaticDiffRows rows={rows} path={selected.path} findingIndex={findingIndex} activeLine={activeLine} onActiveLine={setActiveLine} mode={mode} />}
      </>}
    </section>
  </div>;
}
