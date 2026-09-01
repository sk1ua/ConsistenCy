/**
 * Shared ReviewsSettingsSection contract tests for CKPT4 Slice 5.
 *
 * The section is a READ_ONLY_STATUS presentation of the review pipeline's
 * defaults: the ACTIVE default model from /health (with the saved-vs-active
 * drift note echoing the restart-banner truth when they disagree), the
 * effective review workflow name from /health (the CONSISTENCY_REVIEW_WORKFLOW
 * pipeline — distinct from per-repository workflow bindings), the fixed
 * compile-time context limits, the worker-concurrency pointer (owned by the
 * Runtime section) with in-review agent concurrency fixed at 1, and the
 * honest "no global review policy" row. These tests pin the stable element
 * ids, the absence of ANY interactive control, graceful degradation without
 * health, and zh-CN coverage for every user-visible string.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { HealthResponse, SettingsSnapshot } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { ReviewsSettingsSection } from "./ReviewsSettingsSection";

const savedSettings: SettingsSnapshot = {
  llm: {
    provider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    openaiModel: "",
    deepseekApiKeyConfigured: true,
    openaiApiKeyConfigured: false
  },
  github: {
    appId: "123456",
    oauthClientId: "",
    privateKeyConfigured: true,
    webhookSecretConfigured: true,
    publicReadTokenConfigured: true
  },
  runtime: {
    storage: { kind: "file", configured: true },
    workspace: { configured: true },
    localReview: { configured: false, rootCount: 0 },
    workerConcurrency: 2,
    workerPollIntervalMs: 500,
    webUrl: "http://127.0.0.1:5173",
    apiTokenConfigured: false
  },
  overriddenByEnvironment: [],
  restartRequired: false
};

function makeHealth(overrides?: {
  llmProvider?: string;
  llmModel?: string;
  workerConcurrency?: number;
  reviewWorkflow?: string;
}): HealthResponse {
  return {
    ok: true,
    service: "consistency-api",
    database: { ok: true },
    worker: { running: true, activeJobs: 0, concurrency: overrides?.workerConcurrency ?? 2 },
    llmProvider: overrides?.llmProvider ?? "deepseek",
    llmModel: overrides?.llmModel ?? "deepseek-chat",
    publicPrAccessMode: "anonymous",
    configuration: {
      githubAppConfigured: true,
      webhookSecretConfigured: true,
      publicReadTokenConfigured: true,
      storage: { kind: "file", configured: true },
      workerConcurrency: overrides?.workerConcurrency ?? 2,
      ...(overrides?.reviewWorkflow === undefined ? {} : { reviewWorkflow: overrides.reviewWorkflow })
    }
  };
}

function renderSection(options?: { settings?: SettingsSnapshot; health?: HealthResponse; locale?: "en-US" | "zh-CN" }): string {
  const { settings = savedSettings, health, locale = "en-US" } = options ?? {};
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ReviewsSettingsSection settings={settings} health={health} />
    </I18nProvider>
  );
}

describe("ReviewsSettingsSection structure", () => {
  it("renders the stable row ids and the section title without a section number", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain("Review defaults");
    expect(html).toContain('id="setting-reviews-model"');
    expect(html).toContain('id="setting-reviews-workflow"');
    expect(html).toContain('id="setting-reviews-context"');
    expect(html).toContain('id="setting-reviews-concurrency"');
    expect(html).toContain('id="setting-reviews-other"');
    expect(html).not.toMatch(/0\d · Reviews/);
  });

  it("exposes zero interactive controls — read-only status, no fake inputs", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <ReviewsSettingsSection settings={savedSettings} health={makeHealth()} />
        </I18nProvider>
      );
    });

    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("textarea")).toHaveLength(0);
    // The whole section is note rows only.
    expect(container.querySelectorAll(".setting-field")).toHaveLength(5);
    expect(container.querySelectorAll(".setting-field.setting-note")).toHaveLength(5);

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("ReviewsSettingsSection default-model truth (Settings ≠ Active)", () => {
  it("shows the ACTIVE provider and model from health when saved and active agree", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain("DeepSeek · deepseek-chat");
    expect(html).not.toContain("restart required");
  });

  it("echoes the saved-vs-active drift note only when the saved model differs from the active one", () => {
    const drifted = renderSection({ health: makeHealth({ llmProvider: "openai", llmModel: "gpt-4.1-mini" }) });
    expect(drifted).toContain("DeepSeek · deepseek-chat");
    expect(drifted).toContain("OpenAI · gpt-4.1-mini");
    expect(drifted).toContain("Saved DeepSeek · deepseek-chat · Active OpenAI · gpt-4.1-mini — restart required");

    // Saved equals active: no drift note, even though the row still shows
    // the active truth.
    const aligned = renderSection({ health: makeHealth() });
    expect(aligned).not.toContain("restart required");
  });

  it("shows the not-configured fallback when no provider is active", () => {
    const html = renderSection({ health: makeHealth({ llmProvider: "none", llmModel: undefined }) });
    expect(html).toContain("Not configured");
  });
});

describe("ReviewsSettingsSection workflow, limits, concurrency and policy rows", () => {
  it("reports the effective review workflow name from health", () => {
    const html = renderSection({ health: makeHealth({ reviewWorkflow: "pr-review" }) });
    expect(html).toContain("Review workflow");
    expect(html).toContain("pr-review");
    expect(html).toContain("CONSISTENCY_REVIEW_WORKFLOW");
  });

  it("degrades to not-reported when an older API omits reviewWorkflow", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain("Not reported");
  });

  it("renders the fixed compile-time context limits as static values", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain("Context limits");
    expect(html).toContain("Per file 256 KB · Total 2 MB · Diff 1 MB");
    expect(html).toContain("Fixed compile-time limits; not configurable in this version.");
  });

  it("points worker concurrency at the Runtime section with fixed agent concurrency", () => {
    const html = renderSection({ health: makeHealth({ workerConcurrency: 3 }) });
    expect(html).toContain("Concurrency");
    expect(html).toContain("Workers 3 · In-review agent concurrency fixed at 1");
    expect(html).toContain("Adjust worker concurrency in the Runtime section");
  });

  it("states honestly that no global review policy exists", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain("Other defaults");
    expect(html).toContain("Not available yet");
    expect(html).toContain("There is no global review policy in this version");
  });
});

describe("ReviewsSettingsSection graceful degradation", () => {
  it("hides the health-derived rows and keeps the static rows when health is absent", () => {
    const html = renderSection();
    expect(html).toContain("Review defaults");
    expect(html).toContain('id="setting-reviews-context"');
    expect(html).toContain('id="setting-reviews-other"');
    expect(html).not.toContain('id="setting-reviews-model"');
    expect(html).not.toContain('id="setting-reviews-workflow"');
    expect(html).not.toContain('id="setting-reviews-concurrency"');
    expect(html).not.toContain("Not configured");
    expect(html).not.toContain("restart required");
  });
});

describe("ReviewsSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection({
      health: makeHealth({ llmProvider: "openai", llmModel: "gpt-4.1-mini", reviewWorkflow: "pr-review" }),
      locale: "zh-CN"
    });
    expect(html).toContain("审查默认值");
    expect(html).toContain("新审查使用的只读默认值；按次审查的选择在审查对话框中进行。");
    expect(html).toContain("默认模型");
    expect(html).toContain("已保存 DeepSeek · deepseek-chat · 当前生效 OpenAI · gpt-4.1-mini — 需重启后生效");
    expect(html).toContain("全局默认值在“模型”分区修改；每次审查可在审查对话框中覆盖模型选择。");
    expect(html).toContain("由环境变量 CONSISTENCY_REVIEW_WORKFLOW 决定的审查管线工作流；仓库级工作流绑定在仓库的工作流页签管理。");
    expect(html).toContain("上下文上限");
    expect(html).toContain("单文件 256 KB · 汇总上限 2 MB · Diff 1 MB");
    expect(html).toContain("固定上限，当前版本不可配置。");
    expect(html).toContain("并发");
    expect(html).toContain("工作进程 2 · 单次审查内代理并发固定为 1");
    expect(html).toContain("工作进程并发在“运行环境”分区调整；单次审查内的代理并发在当前版本固定为 1。");
    expect(html).toContain("其他默认值");
    expect(html).toContain("当前版本没有全局审查策略；按次设置在审查对话框中覆盖。");
    expect(html).not.toContain("Review defaults");
    expect(html).not.toContain("Context limits");
    expect(html).not.toContain("restart required");
    expect(html).not.toContain("Not available yet");
  });

  it("translates the not-configured model and not-reported workflow variants", () => {
    const html = renderSection({ health: makeHealth({ llmProvider: "none" }), locale: "zh-CN" });
    expect(html).toContain("未配置");
    expect(html).toContain("未报告");
  });
});
