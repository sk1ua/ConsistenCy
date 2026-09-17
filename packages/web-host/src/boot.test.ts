import { describe, expect, it } from "vitest";
import { createWebHost, installPlugins } from "./boot.js";
import { uiServicesPlugin } from "./plugins/ui-services.js";

describe("web-host Cordis boot", () => {
  it("provides ui.* registries on the Cordis root", () => {
    const host = createWebHost();
    expect(host.ctx.get("ui.nav")).toBe(host.ui.nav);
    expect(host.ctx.get("ui.commands")).toBe(host.ui.commands);
    expect(host.ctx.get("ui.routes")).toBe(host.ui.routes);
    expect(host.ctx.get("ui.inspector")).toBe(host.ui.inspector);
    expect(host.ctx.get("ui.status")).toBe(host.ui.status);
    expect(host.ctx.get("ui.slots")).toBe(host.ui.slots);
  });

  it("installs the uiServicesPlugin against a live host", () => {
    const host = createWebHost();
    expect(() => installPlugins(host, [uiServicesPlugin])).not.toThrow();
  });

  it("accepts nav and status contributions", () => {
    const host = createWebHost();
    host.ui.nav.register({ id: "inbox", to: "/inbox", label: "Inbox", order: 10 });
    host.ui.status.register({ id: "api", label: "API", tone: "success", order: 1 });
    expect(host.ui.nav.list().map(item => item.id)).toEqual(["inbox"]);
    expect(host.ui.status.list()[0]?.tone).toBe("success");
  });
});
