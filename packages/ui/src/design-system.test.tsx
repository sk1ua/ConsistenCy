import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Button, ButtonLink } from "./Button";
import { AppLink, ExternalLink } from "./Link";
import { SidebarRow } from "./SidebarRow";
import { Tabs } from "./Tabs";
import { Badge } from "./Badge";
import { Breadcrumb } from "./Breadcrumb";
import { Dialog } from "./Dialog";
import { SectionHeader } from "./SectionHeader";
import { EmptyState } from "./EmptyState";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("Design System Core Primitives", () => {
  describe("Button", () => {
    it("renders with variant classes and label", () => {
      const html = renderToString(<Button variant="primary">审查代码</Button>);
      expect(html).toContain("ds-button");
      expect(html).toContain("ds-button--primary");
      expect(html).toContain("审查代码");
    });

    it("renders disabled attribute on loading", () => {
      const html = renderToString(<Button loading>处理中</Button>);
      expect(html).toContain("disabled");
      expect(html).toContain('aria-disabled="true"');
    });

    it("renders active state class for pressed controls", () => {
      const html = renderToString(<Button variant="ghost" active aria-pressed={true}>Active</Button>);
      expect(html).toContain("ds-button--active");
      expect(html).toContain('aria-pressed="true"');
    });

    it("ButtonLink renders primary anchor with ds-button classes and no ds-app-link", () => {
      const html = renderToString(
        <MemoryRouter>
          <ButtonLink to="/repositories/repo-1" variant="primary" size="sm">Open</ButtonLink>
        </MemoryRouter>
      );
      expect(html).toContain("ds-button");
      expect(html).toContain("ds-button--primary");
      expect(html).toContain("ds-button--sm");
      expect(html).toContain('href="/repositories/repo-1"');
      expect(html).not.toContain("ds-app-link");
    });
  });

  describe("Link Semantics", () => {
    it("renders AppLink with no text underline class", () => {
      const html = renderToString(
        <MemoryRouter>
          <AppLink to="/repositories">代码仓库</AppLink>
        </MemoryRouter>
      );
      expect(html).toContain("ds-app-link");
      expect(html).toContain('href="/repositories"');
      expect(html).toContain("代码仓库");
    });

    it("guards every internal link state from browser underlines", () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const css = readFileSync(join(here, "design-system.css"), "utf8");
      expect(css).toContain(".ds-app-link:visited");
      expect(css).toContain(".ds-app-link:active");
      expect(css).toContain("text-decoration: none !important");
    });

    it("renders ExternalLink with target _blank and noopener", () => {
      const html = renderToString(<ExternalLink href="https://docs.consistency.dev">官方文档</ExternalLink>);
      expect(html).toContain("ds-external-link");
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });
  });

  describe("SidebarRow", () => {
    it("renders nav link with icon and badge", () => {
      const html = renderToString(
        <MemoryRouter>
          <SidebarRow to="/repositories" label="代码仓库" icon={<span>icon</span>} badge={<Badge size="sm">1</Badge>} />
        </MemoryRouter>
      );
      expect(html).toContain("ds-sidebar-row");
      expect(html).toContain("代码仓库");
      expect(html).toContain("ds-badge");
    });
  });

  describe("Tabs", () => {
    it("renders navigation tab items and highlights active tab", () => {
      const tabs = [
        { id: "overview", label: "概览" },
        { id: "changes", label: "变更", count: 3 }
      ];
      const html = renderToString(<Tabs tabs={tabs} activeId="overview" onChange={() => {}} />);
      expect(html).toContain("ds-tabs-nav");
      expect(html).toContain("ds-tab-button--active");
      expect(html).toContain("概览");
      expect(html).toContain("3");
    });
  });

  describe("Dialog", () => {
    it("renders dialog shell when open", () => {
      const html = renderToString(
        <Dialog isOpen={true} onClose={() => {}} title="发起审查">
          <p>Dialog Body</p>
        </Dialog>
      );
      expect(html).toContain('role="dialog"');
      expect(html).toContain("发起审查");
      expect(html).toContain("Dialog Body");
    });

    it("renders nothing when closed", () => {
      const html = renderToString(
        <Dialog isOpen={false} onClose={() => {}} title="Closed">
          <p>Hidden</p>
        </Dialog>
      );
      expect(html).toBe("");
    });
  });

  describe("EmptyState & SectionHeader", () => {
    it("renders section header and empty state concisely", () => {
      const headerHtml = renderToString(<SectionHeader title="最近审查记录" />);
      expect(headerHtml).toContain("最近审查记录");

      const emptyHtml = renderToString(<EmptyState title="暂无审查" description="点击按钮开始" />);
      expect(emptyHtml).toContain("ds-empty-state");
      expect(emptyHtml).toContain("暂无审查");
    });
  });

  it("defines token-driven active buttons and input/select parity", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "design-system.css"), "utf8");
    expect(css).toContain(".ds-button--active");
    expect(css).toContain(".ds-button--active:hover:not(:disabled)");
    expect(css).toContain("background: var(--primary-soft)");
    expect(css).toContain("box-sizing: border-box");
    expect(css).toContain(".ds-select");
    expect(css).toContain(".ds-select:focus");
    expect(css).toContain(".ds-select:disabled");
  });
});
