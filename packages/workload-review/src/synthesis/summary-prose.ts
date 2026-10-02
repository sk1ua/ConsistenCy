/** Model wrappers are data, never prose to publish verbatim. No external XML entities. */
function looksStructured(text: string): boolean {
  return /^[\s]*[\[{<]/.test(text) || /```(?:json|xml)\b|\{\s*"[^"\n]+"\s*:|<summary\b/i.test(text);
}

function decodeXml(text: string): string | undefined {
  let valid = true;
  const decoded = text.replace(/&([^;\s]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity]!;
    const code = /^#x[\da-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16)
      : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      valid = false;
      return "";
    }
    return String.fromCodePoint(code);
  });
  return valid ? decoded : undefined;
}

/** Parse a safe XML subset strictly; malformed/unsupported documents fall back. */
function xmlSummary(source: string): string | undefined {
  const stack: string[] = [];
  let roots = 0;
  let offset = 0;
  let summaryDepth: number | undefined;
  let foundSummary = false;
  let summary = "";
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?xml\s[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/g;
  for (const token of source.matchAll(tokens)) {
    if (token.index !== offset) return undefined;
    const text = token[0];
    offset += text.length;
    if (text.startsWith("<!--") || text.startsWith("<?xml")) continue;
    if (text.startsWith("<![CDATA[")) {
      if (stack.length === 0) return undefined;
      if (summaryDepth !== undefined) summary += text.slice(9, -3);
    } else if (text.startsWith("</")) {
      const name = /^<\/([\w:.-]+)/.exec(text)![1]!;
      if (stack.pop() !== name) return undefined;
      if (summaryDepth !== undefined && stack.length < summaryDepth) summaryDepth = undefined;
    } else if (text.startsWith("<")) {
      const name = /^<([\w:.-]+)/.exec(text)![1]!;
      if (stack.length === 0 && ++roots > 1) return undefined;
      if (!text.endsWith("/>")) {
        stack.push(name);
        if (name === "summary") {
          if (foundSummary) return undefined;
          foundSummary = true;
          summaryDepth = stack.length;
        }
      }
    } else {
      if (stack.length === 0 && text.trim()) return undefined;
      if (summaryDepth !== undefined) {
        const decoded = decodeXml(text);
        if (decoded === undefined) return undefined;
        summary += decoded;
      }
    }
  }
  return offset === source.length && stack.length === 0 && roots === 1 && foundSummary ? summary : undefined;
}

/** Plain text is untouched; JSON/XML must yield a non-structured summary field. */
export function modelSummaryProse(source: string): string | undefined {
  if (!source.trim()) return undefined;
  if (!looksStructured(source)) return source;
  const fenced = /^\s*```(?:json|xml)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(source);
  const body = (fenced?.[1] ?? source).trim();
  let summary: string | undefined;
  if (body.startsWith("<")) summary = xmlSummary(body);
  else {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        && "summary" in parsed && typeof parsed.summary === "string") summary = parsed.summary;
    } catch { /* deterministic overview is preferable to raw provider output */ }
  }
  return summary?.trim() && !looksStructured(summary) ? summary : undefined;
}
