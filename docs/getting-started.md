# 快速上手

这份文档的目标：让你从零跑出第一份审查报告，并且在出问题时知道该看哪里。

---

## 1. 先决条件

| 依赖 | 版本 | 为什么是这个版本 |
|---|---|---|
| Node.js | **22.19.0 以上、23 以下** | 根 `package.json` 的 `engines` 字段写死了 `>=22.19.0 <23`；`scripts/baseline-runtime.mjs:11` 的 `assertNodeBaseline` 会在 `npm run verify:runtime` 时再校验一次 |
| Python | **3.12.x** | `scripts/baseline-runtime.mjs:18` 的 `assertPythonBaseline` 只接受 `3.12.` 前缀，3.11 和 3.13 都会被拒 |
| Git | 任意近期版本 | 审查区间、工作区快照、证据溯源都依赖 git |

本机如果默认装了别的 Node 大版本（例如 24 或 25），`npm run verify:runtime` 会直接失败——这是刻意设计，不是环境噪声。最省事的办法是装一个 22.x 到 PATH 最前面，或者用 nvm/fnm 之类的版本管理器切过去。

---

## 2. 安装

```bash
npm ci
```

Python 侧需要一个 3.12 的虚拟环境。用 uv：

```bash
uv venv --python 3.12 .venv
uv sync --frozen --extra dev
```

没有 uv 就用标准虚拟环境加锁文件：

```bash
python3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-lock.txt
.venv/Scripts/python.exe -m pip install pytest pytest-cov jsonschema ruff
```

CLI 找解释器的顺序（`apps/cli/src/config.ts:57` `resolvePythonPath`）：

1. 显式配置的 `CONSISTENCY_PYTHON_PATH`（若它不等于默认的裸 `python`）
2. `<install root>/.venv/Scripts/python.exe`（Windows）或 `<install root>/.venv/bin/python3`（Unix）
3. PATH 上的 `python`

所以只要 `.venv` 在仓库根目录下，通常什么都不用配。

---

## 3. 配置 LLM provider

产品运行时只接受**真实**的 provider：DeepSeek、OpenAI 或 Anthropic，经捆绑的官方 Pi 运行时调用。没有面向用户的 mock 模式——没配好 provider 时审查会直接拒绝启动，而不是给你一份假报告。

交互式配置：

```bash
npm run setup
```

脚本化配置（适合 CI 或自动化）：

```bash
npm run config -- set llm.provider deepseek
npm run config -- set llm.deepseek-api-key
npm run config -- doctor
```

`npm run config -- set` 接受的键只有这些（kebab-case，全部来自 `apps/api/src/config/cli.ts:13`）：

| 分类 | 键 |
|---|---|
| provider | `llm.provider`（Pi catalog provider id，例如 `xiaomi`、`deepseek`、`openai`、`anthropic`） |
| Generic Pi provider | `llm.api-key`、`llm.model`（密钥加密保存，适用于 Xiaomi 等 Pi catalog provider） |
| DeepSeek | `llm.deepseek-api-key`、`llm.deepseek-model`、`llm.deepseek-base-url` |
| OpenAI | `llm.openai-api-key`、`llm.openai-model` |
| Anthropic | `llm.anthropic-api-key`、`llm.anthropic-model` |
| GitHub | `github.app-id`、`github.private-key`、`github.webhook-secret`、`github.public-read-token` |
| runtime | `runtime.database-path`、`runtime.workspace-root`、`runtime.worker-concurrency`、`runtime.worker-poll-ms`、`runtime.web-url`、`runtime.api-token` |

带 `-api-key`、`-private-key`、`-webhook-secret`、`-public-read-token`、`-api-token` 的键是 secret：不传第三个参数时会交互式隐藏输入。也可省略 `llm.api-key` 的值，进行隐藏式交互输入。全部配置不写在仓库里，而是落在 `.consistency/`（已 gitignore）：

- `config.json` —— 非敏感设置
- `secrets.enc.json` + `config.key` —— 加密后的密钥
- `consistency.db` —— SQLite
- `workspaces/`、`cli/`、`knowledge/*.sqlite`

配置优先级是 **settings 文件 → `.env` → 进程环境变量**，后者覆盖前者。所以 `DEEPSEEK_API_KEY=... npm run consistency -- review` 这种临时覆盖是生效的。

想检查配置是否完整：

```bash
npm run config -- doctor
```

它逐项打印 `✓` / `!` / `✗`，有硬失败时退出码为 1。GitHub App 没配只会是警告（`!`），不影响本地审查。

---

## 4. 跑第一次审查

`consistency review` 只有两种范围：**未提交的工作区改动**，或**一个提交区间**。

### 审查当前仓库的未提交改动

```bash
npm run consistency -- review
```

注意 `--` ：它把后面的参数原样传给 `consistency` 这个脚本，少了它 npm 会自己吃掉参数。

### 审查别的仓库

```bash
npm run consistency -- review --repo D:/work/some-checkout
```

`--repo` 指向的仓库是**只读输入**。审查产物写到 ConsistenCy 自己的 `.consistency/cli/` 下，不会在别人的仓库里留下任何文件。

### 审查一个提交区间

```bash
npm run consistency -- review --repo D:/work/some-checkout --base main --head HEAD
```

区间语义：`--base` 是起点，`--head` 是终点，省略 `--head` 时默认 `HEAD`。

有一条刻意的失败设计：**只传 `--head` 而不传 `--base` 会直接报错**，而不是静默退化成工作区审查。因为底层只有在两个 ref 都存在时才做区间 diff，静默退化会让你以为自己在审 `main..HEAD`，实际审的是别的东西。

### 其他常用选项

```bash
npm run consistency -- review --verbose          # 每条 finding 附带证据、研判、修复建议
npm run consistency -- review --all              # 打印全部 finding
npm run consistency -- review --limit 5          # 只打印前 5 条
npm run consistency -- review --threshold high   # 只把 high 及以上算作达标
npm run consistency -- review --language en-US   # 报告语言（默认 zh-CN）
npm run consistency -- review --json             # 输出完整 ReviewReport JSON
```

完整选项列表：

```bash
npm run consistency -- review --help
```

---

## 5. 怎么看报告

报告头给出两个**互相独立**的量，它们不是同一件事的两种说法：

```
  88 静态分析评分 · 风险 低    结论风险带 中
      （两者独立：评分来自确定性静态分析，风险带来自最终 findings 的严重度分布）
```

- **静态分析评分 / 风险等级** —— 确定性静态分析的 triage 信号。
- **结论风险带** —— 最终 findings 的严重度分布。

再往下是 finding 列表，每条的形式是：

```
[中] 标题
    └ 路径/文件.ts:120-140 · 很可能 · security agent · 2 条证据
```

然后是**约束块**，它永远存在，是这份报告最该看的部分：

- `✓ 本次审查覆盖完整` —— 所有已启用的分析都执行了。
- `· 本次审查未记录覆盖范围` —— coverage 缺失，无法确认哪些分析真的跑过。注意它**不是**绿勾。
- `[!]` 开头 —— **该部分本次没有检查，不代表已检查且通过**。
- `[~]` 开头 —— 已检查，但证据链不完整。
- `[!]` / `[~]` 的条数还会出现在报告头右上角，方便快速扫一眼。

设计上只有一条铁律：**没能检查到什么，比检查到了什么更显眼**。一次降级运行的「无 findings」，不允许看起来像一次完整运行的「无 findings」。

---

## 6. 退出码：直接当 CI 闸门

| 退出码 | 含义 | 能否当闸门 |
|---|---|---|
| `0` | 跑完，没有任何 finding 达到阈值 | 可以 |
| `1` | 跑完，且有 finding 达到阈值 | 可以（这就是拦截） |
| `2` | **没跑成，或本次审查覆盖不完整** | **不可以** |

`2` 是关键的一档：它区分「跑通了但没查到东西」和「压根没查全」。后者可能来自某个专项 agent 失败、Planner 失败、Synthesizer 失败，或确定性引擎有步骤被跳过。

放进 CI：

```yaml
- run: npm ci
- run: npm run consistency -- review --threshold high
```

退出码的唯一判定点在 `apps/cli/src/report.ts:425` 的 `exitCodeFor()`，CLI 与测试共用它，不会漂移。

---

## 7. 用 JSON 接进自己的流程

```bash
npm run consistency -- review --json > report.json
```

输出是完整的 `ReviewReport`。字段结构见 [output_schema.md](output_schema.md)，风险规则见 [risk-scoring-rules.md](risk-scoring-rules.md)。

---

## 8. 排错

**`Node 22.19.x or newer required, got v25.x.x`**
你在用系统默认的 Node。切到 22.x（`engines` 要求 `<23`），再跑一次。

**`Python 3.12.x required, got 3.11.x`**
`verify:runtime` 校验的解释器不是 3.12。显式指定：

```powershell
$env:CONSISTENCY_PYTHON_PATH = (Resolve-Path ".venv\Scripts\python.exe").Path
npm run verify:runtime
```

**「没有可用的 LLM provider」**
provider 没配或配得不完整。跑 `npm run config -- doctor` 看哪一项是 `✗`，再用 `npm run config -- set llm.provider ...` 和对应的 `-api-key` 补齐。

**`<路径> 看起来不是 git 仓库（缺 .git）`**
`--repo` 指到了一个非 git 目录。审查还能继续，但只能把文件当不透明文本处理：没有区间 diff，git 证据不可用。这只是一条警告，报告里会如实带上这个限制。

**「配置的 Python 解释器不存在」**
`CONSISTENCY_PYTHON_PATH` 指向的路径不存在。确定性证据层会不可用——报告会降级，不会假装查全了。

**`npm run config -- set` 没带键名就退出 1**
这是预期行为：它会把可用的 18 个键打印出来，然后报 `Unknown config key`。不是命令坏了。

**报告里出现 `[!]`**
说明本次有部分没查。先看约束块里那一行写的补救建议（例如 provider 超时、预算耗尽、Python 引擎不可用），再决定是否重跑。**不要把带 `[!]` 的报告当成「检查过且通过」。**

---

## 9. 命令速查

| 命令 | 作用 |
|---|---|
| `npm run consistency -- review` | 审查当前仓库的未提交改动 |
| `npm run consistency -- review --repo <路径>` | 审查指定仓库 |
| `npm run consistency -- review --base <ref> --head <ref>` | 审查提交区间 |
| `npm run consistency -- review --json` | 输出机器可读报告 |
| `npm run consistency -- help` | 显示顶层帮助 |
| `npm run setup` | 交互式配置 |
| `npm run config -- show` | 显示当前配置快照 |
| `npm run config -- doctor` | 体检配置 |
| `npm run config -- set <键> <值>` | 设置单个配置项 |
| `npm run dev:api` | 启动 HTTP daemon（无界面） |
| `npm run dev:webhook` | 本地 webhook 开发 |
| `npm run verify` | 跑完整基线验证 |
| `npm run verify:runtime` | 只校验 Node / Python 版本 |
| `npm run verify:docs` | 校验文档规则与链接 |
| `npm test` | TypeScript 测试 + runtime gate |
| `npm run test:python` | Python 测试 |

---

## 10. 下一步

- [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) —— 产品定位与架构分层
- [architecture.md](architecture.md) —— Kernel、Harness、Context VM 的细节
- [capability-matrix.md](capability-matrix.md) —— 今天实际强制执行了什么
- [security.md](security.md) —— 能力中介与隔离的真实边界
- [configuration.md](configuration.md) —— 完整配置参考
