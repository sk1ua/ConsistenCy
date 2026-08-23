import { describe, it, expect, vi, afterEach } from "vitest";
import { openExternalUrl } from "./desktop";

describe("openExternalUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls window.open with _blank and noopener,noreferrer", () => {
    const openMock = vi.fn();
    vi.stubGlobal("window", { open: openMock });

    openExternalUrl("https://example.com");
    
    expect(openMock).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
