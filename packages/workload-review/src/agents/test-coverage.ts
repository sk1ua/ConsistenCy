import type { PRReviewContext, ReviewFinding } from "@consistency/schema";
import { changedLineRanges } from "./grounding.js";

/** Only coverage suggestions are gated here; defective tests remain findings. */
export function isMissingCoverageFinding(finding: ReviewFinding): boolean {
  const prose = `${finding.title} ${finding.evidence} ${finding.reasoning}`;
  return /\b(?:coverage|uncovered|untested)\b|\b(?:missing|lacks?|without|no|absent)\b[^.\n]{0,60}\btests?\b|\b(?:add|write)\b[^.\n]{0,30}\btests?\b|未覆盖|缺[少乏].{0,20}测试|没有.{0,12}测试|补充.{0,12}测试|增加.{0,12}测试/i.test(prose);
}

function concreteScenario(trigger: string | undefined): boolean {
  if (!trigger || /\b(?:coverage|new code|missing tests?|untested code)\b|测试覆盖|缺少测试|新代码/i.test(trigger)) return false;
  if (/^(?:any|all|every)\s+(?:input|scenario|case|change)|^(?:missing|insufficient|lack of)\s+(?:tests?|coverage)|^(?:所有|任意)(?:输入|场景|改动)|^(?:缺少|没有)测试/i.test(trigger.trim())) return false;
  // A conditional word alone ("when this function is called") is not a
  // scenario. Require an explicit value, condition, or failure state instead.
  return /\b(?:empty|null|undefined|true|false|invalid|malformed|zero|negative|timeout|failure|exception|error|missing|absent|omits?|unauthenticated|anonymous|cancelled|concurrent|overflow|stale|duplicate|expired)\b|["'`]|\d|为空|空值|异常|失败|超时|无效|负数|零值|取消|并发|溢出|重复|过期/i.test(trigger);
}

function scopeEnd(lines: readonly string[], index: number): number {
  const header = lines[index]!;
  const indent = /^\s*/.exec(header)![0].length;
  if (header.trimEnd().endsWith(":")) {
    let end = index;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next]!.trim() && /^\s*/.exec(lines[next]!)![0].length <= indent) break;
      end = next;
    }
    return end + 1;
  }
  let balance = 0;
  let opened = false;
  for (let next = index; next < lines.length; next += 1) {
    const code = lines[next]!.replace(/\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "");
    for (const char of code) {
      if (char === "{") { balance += 1; opened = true; }
      if (char === "}") balance -= 1;
    }
    if (opened && balance <= 0) return next + 1;
    if (!opened && next > index) break;
  }
  return index + 1;
}

/**
 * Fail closed unless visible source establishes a touched function/branch,
 * the finding points inside it, and an explicit missing scenario is supplied.
 * This is a conservative textual scope check, not execution of reviewed code.
 */
export function hasSpecificChangedCoverageTarget(finding: ReviewFinding, context: PRReviewContext): boolean {
  if (!concreteScenario(finding.trigger) || finding.startLine === undefined || finding.baselineAssessment?.behaviorUnchanged === true) return false;
  const changed = context.changedFiles.find(file => file.path === finding.file);
  const source = context.fileContents[finding.file];
  if (!changed || source === undefined) return false;
  const lines = source.split(/\r?\n/);
  const changes = changed.status === "added" ? [{ start: 1, end: lines.length }] : changedLineRanges(changed.patch);
  const prose = `${finding.title} ${finding.evidence} ${finding.reasoning}`;
  const compactProse = prose.replace(/\s|`/g, "");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const name = /^\s*(?:async\s+)?def\s+([\w$]+)/.exec(line)?.[1]
      ?? /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)/.exec(line)?.[1]
      ?? /^\s*(?:(?:export|public|private|protected|static|async|const|let|var)\s+)*([\w$]+)\s*(?:=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|\([^)]*\)(?:\s*:\s*[^={]+)?\s*\{)/.exec(line)?.[1];
    const branch = /^\s*(?:if|elif|else|except|catch|case|switch)\b/.test(line);
    const functionName = name && !/^(?:if|for|while|switch|catch|with)$/.test(name) ? name : undefined;
    if (!functionName && !branch) continue;
    const start = index + 1;
    const end = scopeEnd(lines, index);
    if (finding.startLine < start || finding.startLine > end || !changes.some(range => range.start <= end && range.end >= start)) continue;
    if (functionName && new RegExp(`(^|[^\\w$])${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`).test(prose)) return true;
    const branchHeader = line.trim().replace(/[{:]\s*$/, "").replace(/\s/g, "");
    if (branch && branchHeader.length >= 5 && compactProse.includes(branchHeader)) return true;
  }
  return false;
}
