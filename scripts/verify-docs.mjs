import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const documentationRoots = [root, join(root, "docs"), join(root, "evaluation")];
const forbiddenPatterns = [
  /(^|[\\/])backend([\\/]|$)/i,
  /AnalysisPipeline/i,
  /run_public_pr_reports\.py/i,
  /design-qa\.md/i,
  /output[\\/]playwright/i,
  /requirements-dev\.txt/i,
  /(^|[\s`])npm install([\s`]|$)/i,
  /ConsistenCy_V2_.*(?:Audit|Acceptance|Gate)/i,
  /本轮包装/,
  /本轮重构/,
  /阶段性/,
  /验收/,
  /Audit Report/i
];

function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".workbuddy", ".claude", ".consistency", "node_modules", "repos", "results", "data", "__pycache__"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(path));
    else if (extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function relativePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

const files = [...new Set(documentationRoots.flatMap(walkMarkdown))];
const violations = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) violations.push(`${relativePath(file)} contains ${pattern}`);
  }

  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (/^(?:https?:|mailto:|#|data:)/i.test(target)) continue;
    const localTarget = target.split("#", 1)[0].split("?", 1)[0];
    if (!localTarget) continue;
    const resolved = resolve(dirname(file), localTarget);
    if (!existsSync(resolved)) violations.push(`${relativePath(file)} links to missing ${target}`);
  }
}

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const obsoleteTracked = tracked.filter(path => {
  const name = path.split("/").at(-1) ?? path;
  return /ConsistenCy_V2_.*(?:Audit|Acceptance|Gate)/i.test(name)
    || path === "design-qa.md"
    || path.startsWith("docs/design/")
    || path === "docs/assets/showcase.png"
    || path.startsWith("output/playwright/");
}).filter(path => existsSync(join(root, path)));

for (const path of obsoleteTracked) violations.push(`obsolete tracked file still exists: ${path}`);

const rootFiles = readdirSync(root).filter(name => statSync(join(root, name)).isFile());
for (const name of rootFiles) {
  if (/ConsistenCy_V2_.*(?:Audit|Acceptance|Gate)/i.test(name)) violations.push(`obsolete root audit file still exists: ${name}`);
}

// 人类可见文件中不允许出现 "ConsistenCy V2" 旧叙事；jobs_v2、stateDiagram-v2、flowchart-v2 等技术标识不在此列。
const humanVisibleFiles = [
  "README.md",
  "examples/multi_agent_demo.py",
  "tests/test_demo.py",
  "tests/test_engine.py",
  "tests/e2e/full-stack.spec.ts"
];
for (const rel of humanVisibleFiles) {
  const path = join(root, rel);
  if (!existsSync(path)) continue;
  const content = readFileSync(path, "utf8");
  if (/ConsistenCy V2/i.test(content)) violations.push(`${rel} contains human-visible "ConsistenCy V2" wording`);
}

if (violations.length > 0) {
  console.error("Documentation verification failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Documentation verification passed (${files.length} Markdown files checked).`);
