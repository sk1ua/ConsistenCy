// Governance closeout helper (CKPT3 Phase 5): checks a markdown source
// against the same forbidden patterns scripts/verify-docs.mjs enforces, then
// copies it byte-for-byte into docs/. Read-only checks print to stdout.
import { copyFileSync, readFileSync } from "node:fs";

const [source, target] = process.argv.slice(2);
if (!source || (target && !target.startsWith("docs/"))) {
  throw new Error("usage: node governance-copy.mjs <source.md> [docs/<name>.md]");
}

const content = readFileSync(source, "utf8");
const patterns = [
  [/(^|[\\/])backend([\\/]|$)/i, "backend-path"],
  [/AnalysisPipeline/i, "AnalysisPipeline"],
  [/design-qa\.md/i, "design-qa"],
  [/output[\\/]playwright/i, "output/playwright"],
  [/requirements-dev\.txt/i, "requirements-dev"],
  [/(^|[\s`])npm install([\s`]|$)/i, "npm install"],
  [/ConsistenCy_V2_.*(?:Audit|Acceptance|Gate)/i, "V2-Audit/Acceptance/Gate"],
  [/本轮包装/, "本轮包装"],
  [/本轮重构/, "本轮重构"],
  [/阶段性/, "阶段性"],
  [/验收/, "验收"],
  [/Audit Report/i, "Audit Report"],
];
const hits = [];
for (const [pattern, name] of patterns) {
  if (pattern.test(content)) hits.push(name);
}
console.log("forbidden hits:", hits.length ? hits.join(", ") : "NONE");
console.log("lines:", content.split("\n").length);
console.log("bytes:", Buffer.byteLength(content, "utf8"));

if (target) {
  copyFileSync(source, target);
  const copied = readFileSync(target, "utf8");
  console.log("copied verbatim:", copied === content);
}
