# ConsistenCy v3 — Web Reference Audit & Design Specification

This document records the forensic reference audit of modern desktop developer/agent tools (DeepSeek Harness, cdesktop / Claude Code Desktop, and OpenCode Desktop) to guide ConsistenCy's Shell and Repository Overview interaction architecture.

---

## 1. Reference Analysis

### A. DeepSeek Harness

#### Inspected Dimensions & Design Rules:
- **Shell Architecture**: Unified single sidebar (230px fixed width), top breadcrumb navigation bar (42px height), bottom status strip (26px height).
- **Control Sizing**:
  - Toolbar controls: 28px–30px
  - Regular buttons / inputs: 32px–34px
  - Primary hero action: max 36px
  - Sidebar row: 30px–32px
  - Border radius: 5px–6px (`--radius-md`)
- **Typography**:
  - Technical metadata / tags: 11px (`IBM Plex Mono` / `Cascadia Code`)
  - Secondary descriptions: 12px
  - Body / Table rows / Navigation: 13px
  - Section title: 14px (semibold)
  - Object / Repository title: 17px–18px (bold)
- **What We Adopt**:
  1. Dense, content-driven layouts instead of nested decorative cards.
  2. Status dot indicators with semantic badges (`var(--success)`, `var(--warning)`, `var(--danger)`).
  3. Key-value metadata strips with subtle border separators.
  4. Single persistent sidebar without multi-rail clutter.
- **What We Explicitly Reject**:
  1. Chat-first canvas (ConsistenCy is an evidence-grounded review harness, not a freeform chatbot).
  2. Large marketing cards and hero banners with 400px empty space.

---

### B. cdesktop / Claude Code Desktop

#### Inspected Dimensions & Design Rules:
- **Project Navigation**:
  - Top of sidebar contains the current repository header with quick project switcher and connect action.
- **Contextual Panel (Selection-Driven Inspector)**:
  - Width is strictly `0px` and hidden when nothing is selected.
  - Opens to 360px–380px on demand when an item (Finding, Commit, Agent, Evidence) is selected.
  - Clean close button (X) and ESC key listener.
- **What We Adopt**:
  1. Selection-driven Inspector model (0px default width).
  2. Single project anchor at the top of the sidebar.
  3. Dense commit list and review activity rows.
- **What We Explicitly Reject**:
  1. Permanent empty right-hand panel placeholder.
  2. Vague hyperlink actions ("查看全部 →").

---

### C. OpenCode Desktop

#### Inspected Dimensions & Design Rules:
- **Developer Grammar**:
  - Git commit hashes always rendered in monospace with 7-character truncated pills.
  - Command palette (`Ctrl+K` / `Cmd+K`) for fast keyboard navigation across repositories, runs, and settings.
  - Explicit button primitives with hover states rather than browser-style underlined hypertext.
- **What We Adopt**:
  1. Command palette (`Ctrl+K` / `Cmd+K`) with category sections.
  2. Action grammar: commands use `Button` / `IconButton`, navigation uses `SidebarRow` / `Tabs` / `Breadcrumb`, external docs use `ExternalLink`.
  3. No browser-style text links for internal actions.
- **What We Explicitly Reject**:
  1. Raw unstyled HTML form elements.
  2. Duplicate navigation trees for the same repository.

---

## 2. ConsistenCy Design Language Synthesis

### Explicit Action Grammar:
| Action Type | Component Used | Styling Rule |
| :--- | :--- | :--- |
| **Primary Navigation** | `SidebarRow`, `Tabs`, `Breadcrumb` | High-contrast label, active pill/underline, no blue text, no text-decoration |
| **Command / Execution** | `Button` (`variant="primary"`, `"secondary"`, `"outline"`) | 32px–36px height, 6px radius, icon + text |
| **Icon Tool Actions** | `IconButton` (`variant="ghost"`, `"outline"`) | 28px–32px square, tooltip on hover |
| **Contextual Row Select** | Clickable list row / `DataTable` row | Subtle background hover (`var(--surface-subtle)`), row selection state |
| **External Documentation** | `ExternalLink` | Clearly marked with external icon, delegates safely to system browser |

### Color & Elevation Matrix:
- **Light Theme**:
  - Background: `#f6f8f5`
  - Surface: `#ffffff`
  - Surface Subtle (Hover/Row): `#f0f3f0`
  - Border: `#dbe1dd`
  - Border Strong: `#c8d0cb`
  - Primary: `#2f6bff`
  - Success: `#16856b`
  - Warning: `#b66a12`
  - Danger: `#d14d3e`
- **Dark Theme**:
  - Background: `#0b0d10`
  - Surface: `#12161c`
  - Surface Subtle (Hover/Row): `#1a2028`
  - Border: `#232932`
  - Border Strong: `#303945`
  - Primary: `#3b82f6`
  - Success: `#10b981`
  - Warning: `#f59e0b`
  - Danger: `#ef4444`

---

## 3. Shell & Repository Overview Prototype Scope

### Surface 1: Global Desktop Shell
- **Sidebar (230px)**:
  - Brand header: ConsistenCy logo + `v3` badge.
  - Active Repository card with quick connect button.
  - Primary navigation links:
    1. 代码仓库 (`Repositories`)
    2. 审查运行 (`Runs`)
    3. 审查发现 (`Findings`)
    4. 工作流定义 (`Workflows`)
    5. 系统设置 (`Settings`)
  - Daemon status footer with pulse indicator.
- **Top Location Bar (42px)**:
  - Location breadcrumb: e.g. `ConsistenCy / 仓库概览`.
  - Actions: Search (`Ctrl+K`), Theme Switcher, Refresh.
- **Bottom Status Bar (26px)**:
  - Active branch, active LLM model provenance, API connected status, desktop commit SHA.

### Surface 2: Repository Overview
- **Header**: Repository display name, source badge (`Local Git`), branch & HEAD commit, dirty file count, and primary action button `审查代码` (Review).
- **Navigation Tabs**: `概览` (active), `变更`, `提交历史`, `拉取请求`, `审查记录`, `工作流`.
- **Content**:
  1. Review Readiness Bar: clear indicator of whether working tree or branch has reviewable diffs and LLM configuration state.
  2. Recent Reviews List: compact list of review jobs showing target, status badge, quality score, model used, and timestamp.
  3. Recent Commits List: dense commit rows with 7-char monospace SHA badge, commit message, author, and date.
- **Zero Card-in-Card Clutter**: uses clean sections and rows with dividers.
- **Zero Hyperlink Text**: no `查看全部 →` or underlined text actions.
