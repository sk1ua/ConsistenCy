/**
 * Argument parsing for `consistency review`.
 *
 * Hand-rolled in the same style as `apps/api/src/config/cli.ts:128` (the repo
 * has no commander/yargs and adding one for five flags is not worth a
 * dependency). Parsing is exported separately from execution so the flag
 * semantics — especially the `--base`/`--head` pairing — stay unit-testable
 * without touching git or an LLM provider.
 */

export type ReviewOptions = {
  repoPath: string;
  /** Set only when the user asked for a committed range. */
  baseRef?: string;
  /** Set only when the user asked for a committed range. */
  headRef?: string;
  json: boolean;
  verbose: boolean;
  /** Disable persisted review knowledge for this invocation. */
  noMemory?: boolean;
  /** `undefined` means "no --limit flag"; `--all` sets this to Infinity. */
  limit?: number;
  color?: boolean;
  provider?: string;
  model?: string;
  reportLanguage?: "zh-CN" | "en-US";
  threshold?: string;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const REVIEW_USAGE = `consistency review — 在本地仓库上运行一次真实的 reviewer harness

用法
  consistency review [选项]

范围
  --repo <路径>        要审查的仓库（默认：当前目录；不传区间参数即审查未提交的工作区改动）
  --base <ref>         提交区间的起点，必须与 --head 一起使用
  --head <ref>         提交区间的终点（使用 --base 时默认 HEAD）

输出
  --json               输出机器可读的完整报告 JSON
  --verbose            追加每条 finding 的证据、研判与建议
  --limit <n>          最多打印 n 条 finding
  --all                打印全部 finding（覆盖 --limit）
  --no-color           关闭颜色（NO_COLOR 与非 TTY 输出同样会关闭）

记忆
  --no-memory          不读取或写入持久化知识库（CONSISTENCY_NO_MEMORY=1 同效）

模型
  --language <zh-CN|en-US>   报告语言（默认 zh-CN）
  --threshold <severity>     CI 阈值：critical|high|medium|low|info（默认 low）

退出码
  0  跑完，没有任何 finding 达到阈值
  1  跑完，且有 finding 达到阈值
  2  没跑成，或本次审查覆盖不完整（不能当作 CI 闸门信任）

说明
  传入 --base 而不传 --head 会报错，而不是静默退化成工作区审查：底层
  buildLocalContext 只在 baseRef 与 headRef 同时存在时才做提交区间 diff，
  否则只会收集未提交改动。这个失败模式必须显式暴露，不能被误读。
`;

const FLAGS_WITH_VALUE = new Set(["--repo", "--base", "--head", "--limit", "--language", "--threshold", "--provider", "--model"]);

/** Splits `--flag=value` into `["--flag", "value"]` so both spellings work. */
function splitInlineValue(token: string): string[] {
  if (!token.startsWith("--")) return [token];
  const equals = token.indexOf("=");
  if (equals === -1) return [token];
  return [token.slice(0, equals), token.slice(equals + 1)];
}

export function parseReviewOptions(argv: readonly string[]): ReviewOptions {
  const tokens: string[] = [];
  for (const token of argv) tokens.push(...splitInlineValue(token));

  const options: ReviewOptions = {
    repoPath: process.cwd(),
    json: false,
    verbose: false,
    noMemory: false
  };
  let baseRef: string | undefined;
  let headRef: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (FLAGS_WITH_VALUE.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${token} 需要一个值`);
      }
      index += 1;
      switch (token) {
        case "--repo": options.repoPath = value; break;
        case "--base": baseRef = value; break;
        case "--head": headRef = value; break;
        case "--language":
          if (value !== "zh-CN" && value !== "en-US") {
            throw new UsageError(`--language 只接受 zh-CN 或 en-US，收到 ${value}`);
          }
          options.reportLanguage = value;
          break;
        case "--threshold": options.threshold = value; break;
        case "--provider": options.provider = value; break;
        case "--model": options.model = value; break;
        case "--limit": {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new UsageError(`--limit 需要一个非负整数，收到 ${value}`);
          }
          options.limit = parsed;
          break;
        }
      }
      continue;
    }

    switch (token) {
      case "--json": options.json = true; break;
      case "--verbose": options.verbose = true; break;
      case "--all": options.limit = Number.POSITIVE_INFINITY; break;
      case "--no-color": options.color = false; break;
      case "--no-memory": options.noMemory = true; break;
      case "--color": options.color = true; break;
      case "--help":
      case "-h":
        throw new UsageError("");
      default:
        throw new UsageError(`未知参数：${token}`);
    }
  }

  // The trap this whole pairing exists for: a bare `--base` would otherwise
  // silently review the dirty working tree while the user believes they are
  // reviewing `base..HEAD`.
  if (baseRef !== undefined && headRef === undefined) headRef = "HEAD";
  if (baseRef === undefined && headRef !== undefined) {
    throw new UsageError("--head 必须与 --base 一起使用；只审查工作区改动时请不要传任何区间参数");
  }
  if (baseRef !== undefined) {
    options.baseRef = baseRef;
    options.headRef = headRef;
  }

  return options;
}
