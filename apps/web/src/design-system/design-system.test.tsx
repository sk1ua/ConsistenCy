import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Button } from "./Button";
import { AppLink, ExternalLink } from "./Link";
import { Dialog } from "./Dialog";
import { Tabs } from "./Tabs";
import { Inspector } from "./Inspector";
import { Combobox } from "./Combobox";
import { DataTable } from "./DataTable";
import { Badge } from "./Badge";
import { EmptyState } from "./EmptyState";
import { SectionHeader } from "./SectionHeader";
import { CodeBlock } from "./CodeBlock";

describe("Design System Primitives (SSR / Component Render)", () => {
  describe("Button", () => {
    it("renders with primary variant and children", () => {
      const html = renderToString(
        <Button variant="primary">
          审查代码
        </Button>
      );
      expect(html).toContain("ds-button");
      expect(html).toContain("ds-button--primary");
      expect(html).toContain("审查代码");
    });

    it("renders disabled attribute when loading is true", () => {
      const html = renderToString(<Button loading>执行中</Button>);
      expect(html).toContain("disabled");
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain("执行中");
    });
  });

  describe("Link Semantics", () => {
    it("renders AppLink with ds-app-link class without browser-style underline", () => {
      const html = renderToString(
        <MemoryRouter>
          <AppLink to="/repositories/repo_1">查看仓库</AppLink>
        </MemoryRouter>
      );
      expect(html).toContain("ds-app-link");
      expect(html).toContain('href="/repositories/repo_1"');
      expect(html).toContain("查看仓库");
    });

    it("renders ExternalLink with target=_blank and rel=noopener noreferrer", () => {
      const html = renderToString(<ExternalLink href="https://docs.consistency.dev">官方文档</ExternalLink>);
      expect(html).toContain("ds-external-link");
      expect(html).toContain('href="https://docs.consistency.dev"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });
  });

  describe("Dialog", () => {
    it("renders modal dialog when isOpen is true", () => {
      const html = renderToString(
        <Dialog isOpen={true} onClose={() => {}} title="连接本地仓库">
          <div>Dialog Content</div>
        </Dialog>
      );
      expect(html).toContain('role="dialog"');
      expect(html).toContain("连接本地仓库");
      expect(html).toContain("Dialog Content");
    });

    it("returns null when isOpen is false", () => {
      const html = renderToString(
        <Dialog isOpen={false} onClose={() => {}} title="Closed Dialog">
          <div>Hidden</div>
        </Dialog>
      );
      expect(html).toBe("");
    });
  });

  describe("Tabs", () => {
    it("renders tabs and highlights active tab", () => {
      const tabs = [
        { id: "overview", label: "概览", count: 2 },
        { id: "diff", label: "代码变更" },
        { id: "evidence", label: "证据" }
      ];
      const html = renderToString(<Tabs tabs={tabs} activeId="diff" onChange={() => {}} />);
      expect(html).toContain("ds-tab-button--active");
      expect(html).toContain("代码变更");
      expect(html).toContain("ds-tabs-nav");
    });
  });

  describe("Inspector (Selection-Driven)", () => {
    it("has width 0 and closed class when isOpen is false", () => {
      const html = renderToString(
        <Inspector isOpen={false} onClose={() => {}} title="审查发现详情">
          <div>Finding Data</div>
        </Inspector>
      );
      expect(html).toContain("ds-inspector--closed");
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("Finding Data");
    });

    it("renders open inspector with title and content when isOpen is true", () => {
      const html = renderToString(
        <Inspector isOpen={true} onClose={() => {}} title="审查发现详情">
          <div>Finding Data</div>
        </Inspector>
      );
      expect(html).toContain("ds-inspector--open");
      expect(html).toContain("审查发现详情");
      expect(html).toContain("Finding Data");
    });
  });

  describe("Combobox", () => {
    it("renders selected label and dropdown button", () => {
      const options = [
        { label: "DeepSeek · deepseek-v4-flash", value: "deepseek" },
        { label: "OpenAI · gpt-4.1-mini", value: "openai" }
      ];
      const html = renderToString(<Combobox options={options} value="deepseek" onChange={() => {}} />);
      expect(html).toContain("DeepSeek · deepseek-v4-flash");
    });
  });

  describe("DataTable", () => {
    it("renders data table rows and headers", () => {
      const columns = [
        { key: "sha", header: "Commit SHA" },
        { key: "message", header: "Message" }
      ];
      const data = [
        { sha: "abc1234", message: "feat: new review harness" },
        { sha: "def5678", message: "fix: context vm paging" }
      ];

      const html = renderToString(
        <DataTable
          columns={columns}
          data={data}
          keyExtractor={row => row.sha}
        />
      );
      expect(html).toContain("feat: new review harness");
      expect(html).toContain("fix: context vm paging");
      expect(html).toContain("Commit SHA");
    });
  });

  describe("Badge", () => {
    it("renders normalized status styles", () => {
      const html = renderToString(<Badge variant="critical">CRITICAL</Badge>);
      expect(html).toContain("ds-badge--danger");
      expect(html).toContain("CRITICAL");
    });
  });

  describe("EmptyState", () => {
    it("renders compact empty state message", () => {
      const html = renderToString(
        <EmptyState title="无未完成任务" description="所有审查已成功完成" />
      );
      expect(html).toContain("ds-empty-state");
      expect(html).toContain("无未完成任务");
      expect(html).toContain("所有审查已成功完成");
    });
  });

  describe("SectionHeader & CodeBlock", () => {
    it("renders section header and code block cleanly", () => {
      const headerHtml = renderToString(<SectionHeader title="最近审查记录" />);
      expect(headerHtml).toContain("最近审查记录");

      const codeHtml = renderToString(<CodeBlock code="const a = 1;" language="typescript" />);
      expect(codeHtml).toContain("const a = 1;");
      expect(codeHtml).toContain("typescript");
    });
  });
});
