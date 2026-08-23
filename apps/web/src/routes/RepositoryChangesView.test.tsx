import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { RepositoryChangesView, buildEntries, statusLabel, getNextSelection } from "./RepositoryChangesView";
import type { RepositoryGitStatusResponse, VcsChangedFile } from "@consistency/schema";
import { I18nProvider } from "../i18n";

const mockData: RepositoryGitStatusResponse = {
  repositoryId: "test-repo",
  available: true,
  dirtyFileCount: 2,
  untrackedFileCount: 1,
  changedFiles: [
    {
      path: "src/main.ts",
      status: "modified",
      additions: 10,
      deletions: 5,
      binary: false,
      hunks: [
        {
          header: "@@ -1,5 +1,5 @@",
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          content: " console.log('hello');\n \n-const x = 1;\n+const x = 2;\n "
        }
      ]
    },
    {
      path: "src/old.ts",
      previousPath: "src/very-old.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: []
    }
  ],
  untrackedFiles: ["new-file.txt"],
  remotes: []
};

describe("RepositoryChangesView helpers", () => {
  it("buildEntries sorts and categorizes correctly", () => {
    const entries = buildEntries(mockData);
    expect(entries.length).toBe(3);
    expect(entries[0]!.type).toBe("tracked");
    expect(entries[0]!.key).toBe("tracked:src/main.ts");
    expect(entries[1]!.type).toBe("tracked");
    expect(entries[1]!.key).toBe("tracked:src/old.ts");
    expect(entries[2]!.type).toBe("untracked");
    expect(entries[2]!.key).toBe("untracked:new-file.txt");
  });

  it("statusLabel returns correct initials", () => {
    expect(statusLabel("added")).toBe("A");
    expect(statusLabel("renamed")).toBe("R");
  });

  it("getNextSelection handles up and down correctly", () => {
    const entries = buildEntries(mockData);
    const first = entries[0]!.key;
    const second = entries[1]!.key;
    const third = entries[2]!.key;

    expect(getNextSelection(entries, first, "down")).toBe(second);
    expect(getNextSelection(entries, second, "down")).toBe(third);
    expect(getNextSelection(entries, third, "down")).toBe(third);

    expect(getNextSelection(entries, third, "up")).toBe(second);
    expect(getNextSelection(entries, second, "up")).toBe(first);
    expect(getNextSelection(entries, first, "up")).toBe(first);

    expect(getNextSelection(entries, "unknown", "down")).toBe(first);
  });
});

describe("RepositoryChangesView component", () => {
  it("renders loading/error state", () => {
    const htmlLoad = renderToString(
      <I18nProvider initialLocale="en-US">
        <RepositoryChangesView loading={true} />
      </I18nProvider>
    );
    expect(htmlLoad).toContain("Loading...");

    const htmlErr = renderToString(
      <I18nProvider initialLocale="zh-CN">
        <RepositoryChangesView error={new Error("Secret")} />
      </I18nProvider>
    );
    expect(htmlErr).toContain("加载中...");
    expect(htmlErr).not.toContain("Secret");
  });

  it("renders unavailable state using exact reason", () => {
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <RepositoryChangesView data={{ ...mockData, available: false, reason: "No git repo" }} />
      </I18nProvider>
    );
    expect(html).toContain("No git repo");
  });

  it("renders clean state", () => {
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <RepositoryChangesView data={{ ...mockData, changedFiles: [], untrackedFiles: [], dirtyFileCount: 0, untrackedFileCount: 0 }} />
      </I18nProvider>
    );
    expect(html).toContain("Working directory clean. No changes to show.");

    const htmlZh = renderToString(
      <I18nProvider initialLocale="zh-CN">
        <RepositoryChangesView data={{ ...mockData, changedFiles: [], untrackedFiles: [], dirtyFileCount: 0, untrackedFileCount: 0 }} />
      </I18nProvider>
    );
    expect(htmlZh).toContain("工作区干净。没有可显示的变更。");
  });

  it("renders exact combined files with counts and detail views", () => {
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <RepositoryChangesView data={mockData} />
      </I18nProvider>
    );
    
    expect(html).toContain('class="count-badge count-badge-total"');
    expect(html).toContain("Total");
    expect(html).toContain('class="count-badge count-badge-tracked"');
    expect(html).toContain("Tracked");
    expect(html).toContain('class="count-badge count-badge-untracked"');
    expect(html).toContain("Untracked");
    expect(html).toContain('aria-label="Total: 3"');
    expect(html).toContain('aria-label="Tracked: 2"');
    expect(html).toContain('aria-label="Untracked: 1"');
    expect(html).toContain('<span class="count-badge-label">Total</span><strong class="count-badge-value">3</strong>');
    expect(html).toContain('<span class="count-badge-label">Tracked</span><strong class="count-badge-value">2</strong>');
    expect(html).toContain('<span class="count-badge-label">Untracked</span><strong class="count-badge-value">1</strong>');
    
    // List elements
    expect(html).toContain("src/main.ts");
    expect(html).toContain("src/old.ts");
    expect(html).toContain("new-file.txt");

    // Default selection is the first tracked file (src/main.ts)
    expect(html).toContain("@@ -1,5 +1,5 @@");
    expect(html).toContain("console.log(");

    // Empty lines are preserved
    expect(html).toContain('class="diff-code"></span>');
  });

  it("renders rename info and binary metadata", () => {
    // Select second item by providing data where the first item is the renamed binary
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <RepositoryChangesView data={{ ...mockData, changedFiles: [mockData.changedFiles[1]!] }} />
      </I18nProvider>
    );
    expect(html).toContain("src/very-old.ts");
    expect(html).toContain("src/old.ts");
    expect(html).toContain("Binary file not shown.");

    const htmlZh = renderToString(
      <I18nProvider initialLocale="zh-CN">
        <RepositoryChangesView data={{ ...mockData, changedFiles: [mockData.changedFiles[1]!] }} />
      </I18nProvider>
    );
    expect(htmlZh).toContain("二进制文件不显示。");
  });

  it("renders untracked path-only metadata", () => {
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <RepositoryChangesView data={{ ...mockData, changedFiles: [] }} />
      </I18nProvider>
    );
    expect(html).toContain("Untracked file");
    expect(html).toContain("new-file.txt");

    const htmlZh = renderToString(
      <I18nProvider initialLocale="zh-CN">
        <RepositoryChangesView data={{ ...mockData, changedFiles: [] }} />
      </I18nProvider>
    );
    expect(htmlZh).toContain("未跟踪文件");
    expect(htmlZh).toContain("new-file.txt");
  });
});
