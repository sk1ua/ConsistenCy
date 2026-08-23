import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { RepositoryHistoryView } from "./RepositoryHistoryView";
import type { RepositoryCommitsResponse } from "@consistency/schema";

function renderWithProviders(ui: React.ReactNode, locale: "en-US" | "zh-CN" = "en-US") {
  return renderToString(
    <I18nProvider initialLocale={locale}>
      {ui}
    </I18nProvider>
  );
}

describe("RepositoryHistoryView", () => {
  it("renders loading state", () => {
    const htmlEn = renderWithProviders(<RepositoryHistoryView isLoading />);
    expect(htmlEn).toContain("Loading Git history...");
    expect(htmlEn).toContain("ds-spin");
    
    const htmlZh = renderWithProviders(<RepositoryHistoryView isLoading />, "zh-CN");
    expect(htmlZh).toContain("正在加载提交历史...");
  });

  it("renders the known unavailable reason localized per locale", () => {
    const data: RepositoryCommitsResponse = {
      repositoryId: "repo1",
      available: false,
      reason: "unable to read commit history",
      commits: []
    };
    const htmlZh = renderWithProviders(<RepositoryHistoryView data={data} />, "zh-CN");
    expect(htmlZh).toContain("提交历史不可用");
    expect(htmlZh).toContain("无法读取本地 Git 提交历史。");
    expect(htmlZh).not.toContain("unable to read commit history");

    const htmlEn = renderWithProviders(<RepositoryHistoryView data={data} />);
    expect(htmlEn).toContain("Git history unavailable");
    expect(htmlEn).toContain("Unable to read the local Git commit history.");
  });

  it("falls back to a localized generic reason instead of leaking raw English into zh-CN", () => {
    const data: RepositoryCommitsResponse = {
      repositoryId: "repo1",
      available: false,
      reason: "Missing git binary",
      commits: []
    };
    const htmlEn = renderWithProviders(<RepositoryHistoryView data={data} />);
    expect(htmlEn).toContain("Git history unavailable");
    expect(htmlEn).toContain("Missing git binary");

    const htmlZh = renderWithProviders(<RepositoryHistoryView data={data} />, "zh-CN");
    expect(htmlZh).toContain("提交历史不可用");
    expect(htmlZh).toContain("无法读取本地 Git 提交历史。");
    expect(htmlZh).not.toContain("Missing git binary");
  });

  it("renders empty available state", () => {
    const data: RepositoryCommitsResponse = {
      repositoryId: "repo1",
      available: true,
      commits: []
    };
    const htmlEn = renderWithProviders(<RepositoryHistoryView data={data} />);
    expect(htmlEn).toContain("No commits");
    expect(htmlEn).toContain("No commits found in this repository.");

    const htmlZh = renderWithProviders(<RepositoryHistoryView data={data} />, "zh-CN");
    expect(htmlZh).toContain("暂无提交");
    expect(htmlZh).toContain("当前仓库暂无提交记录。");
  });

  it("renders populated state with commits", () => {
    const data: RepositoryCommitsResponse = {
      repositoryId: "repo1",
      available: true,
      commits: [
        {
          sha: "1234567890abcdef",
          parentShas: ["0987654321fedcba"],
          author: { name: "Test Author", email: "test@example.com" },
          authoredAt: "2026-08-22T10:00:00Z",
          message: "Initial commit"
        }
      ]
    };
    const html = renderWithProviders(<RepositoryHistoryView data={data} />);
    expect(html).toContain("Initial commit");
    expect(html).toContain("Test Author");
    expect(html).toContain("1234567");
  });

  it("respects locale in date formatting", () => {
    const data: RepositoryCommitsResponse = {
      repositoryId: "repo1",
      available: true,
      commits: [
        {
          sha: "1234567890abcdef",
          parentShas: [],
          author: { name: "Test Author" },
          authoredAt: "2026-08-22T10:00:00Z",
          message: "Initial commit"
        }
      ]
    };
    const html = renderWithProviders(<RepositoryHistoryView data={data} />, "zh-CN");
    // Ensure the date string is formatted for zh-CN, which includes "2026", "8", "22"
    expect(html).toContain("2026");
    expect(html).toContain("8");
    expect(html).toContain("22");
  });
});
