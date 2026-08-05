import { useEffect, useMemo, useState } from "react";
import { FileCode2, GitMerge } from "lucide-react";
import type { ReviewFinding, VcsChangedFile } from "@consistency/schema";
import { StatusBadge } from "./StatusBadge";
import { useI18n } from "../i18n";

type Row = { type: "context" | "add" | "del"; oldLine?: number; newLine?: number; text: string };

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
      rows.push({ type: "del", oldLine, newLine: undefined, text });
      oldLine += 1;
    } else if (marker === "+") {
      rows.push({ type: "add", oldLine: undefined, newLine, text });
      newLine += 1;
    } else {
      rows.push({ type: "context", oldLine, newLine, text: raw });
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

export function DiffViewer({ files, findings, focus }: {
  files: VcsChangedFile[];
  findings: ReviewFinding[];
  focus?: { file: string; line?: number };
}) {
  const { t } = useI18n();
  const [selectedPath, setSelectedPath] = useState<string>(files[0]?.path ?? "");
  const [activeLine, setActiveLine] = useState<number>();

  useEffect(() => {
    if (!focus) return;
    setSelectedPath(focus.file);
    setActiveLine(focus.line);
  }, [focus]);

  const selected = files.find(file => file.path === selectedPath) ?? files[0];
  const rows = useMemo(() => selected ? selected.hunks.flatMap(rowsFor) : [], [selected]);

  const findingsAt = (file: string, line?: number): ReviewFinding[] =>
    findings.filter(finding =>
      finding.file === file &&
      (line === undefined || (finding.startLine !== undefined && line >= finding.startLine && (finding.endLine === undefined || line <= finding.endLine)))
    );

  if (files.length === 0) {
    return <div className="empty-state"><GitMerge size={22} />{t("No changes to show.")}</div>;
  }

  return <div className="diff-viewer">
    <aside className="diff-file-list">
      <h3>{t("Changed files")} <span>{files.length}</span></h3>
      {files.map(file => {
        const activeFindings = findingsAt(file.path).length;
        return <button key={file.path} type="button" className={selected?.path === file.path ? "active" : ""} onClick={() => { setSelectedPath(file.path); setActiveLine(undefined); }}>
          <span className={`diff-status diff-status-${file.status}`}>{statusLabel(file.status)}</span>
          <code>{file.path}</code>
          <small>+{file.additions} -{file.deletions}{activeFindings > 0 ? ` · ${activeFindings}` : ""}</small>
        </button>;
      })}
    </aside>
    <div className="diff-content">
      {!selected ? <div className="empty-inline">{t("No changes to show.")}</div> : <>
        <div className="diff-file-head"><FileCode2 size={16} /><strong>{selected.path}</strong><span className={`diff-status diff-status-${selected.status}`}>{statusLabel(selected.status)}</span></div>
        <div className="diff-grid">
          {rows.map((row, index) => {
            const oldFindings = findingsAt(selected.path, row.oldLine);
            const newFindings = findingsAt(selected.path, row.newLine);
            const flagged = newFindings.length > 0 || (row.type === "del" && oldFindings.length > 0);
            const severity = [...newFindings, ...(row.type === "del" ? oldFindings : [])][0]?.severity;
            return <button
              type="button"
              key={`${row.type}-${row.oldLine ?? "o"}-${row.newLine ?? "n"}-${index}`}
              className={`diff-row diff-row-${row.type}${flagged ? ` diff-finding diff-finding-${severity}` : ""}${activeLine !== undefined && row.newLine === activeLine ? " diff-active" : ""}`}
              onClick={() => row.newLine !== undefined && setActiveLine(activeLine === row.newLine ? undefined : row.newLine)}
            >
              <span className="diff-ln">{row.oldLine ?? ""}</span>
              <span className="diff-code">{(row.type === "del" ? "-" : row.type === "add" ? "" : " ")}{row.type === "add" ? "" : row.text}</span>
              <span className="diff-ln">{row.newLine ?? ""}</span>
              <span className="diff-code">{(row.type === "add" ? "+" : row.type === "del" ? "" : " ")}{row.type === "del" ? "" : row.text}</span>
              {activeLine !== undefined && row.newLine === activeLine && newFindings.length > 0 && <span className="diff-popover">
                {newFindings.map(finding => <span key={finding.id}><StatusBadge value={finding.severity} /><strong>{finding.title}</strong></span>)}
              </span>}
            </button>;
          })}
        </div>
      </>}
    </div>
  </div>;
}
