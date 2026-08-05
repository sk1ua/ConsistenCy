import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { HeartbeatWidget } from "./HeartbeatWidget";

function render(widget: React.ReactNode) {
  return renderToString(<I18nProvider initialLocale="en-US">{widget}</I18nProvider>);
}

describe("HeartbeatWidget", () => {
  it("shows the disabled fallback when the daemon is unavailable", () => {
    const html = render(<HeartbeatWidget pulse={null} history={[]} unavailable />);
    expect(html).toContain("Heartbeat is disabled");
  });

  it("waits for the first pulse when no pulse has arrived yet", () => {
    const html = render(<HeartbeatWidget pulse={null} history={[]} unavailable={false} />);
    expect(html).toContain("Waiting for the first pulse");
  });

  it("renders pulse state and metrics", () => {
    const html = render(<HeartbeatWidget
      pulse={{
        pulseId: "pulse_1",
        state: "idle",
        repository: { root: "D:/repo", provider: "local_git", branch: "main" },
        observedAt: "2026-08-05T12:00:00.000Z",
        dirtyFileCount: 3,
        pendingEvents: 0,
        metrics: {
          windowDays: 14,
          churnRate: 42.5,
          riskIndex: 0.2,
          riskIndexTrend: -0.05,
          unsettledSecurityDebt: 2,
          filesTracked: 128,
          computedAt: "2026-08-05T12:00:00.000Z"
        }
      }}
      history={[]}
      unavailable={false}
    />);
    expect(html).toContain("Repository pulse");
    expect(html).toContain("main");
    expect(html).toContain("3");
    expect(html).toContain("42");
    expect(html).toContain("128");
  });
});
