import { describe, expect, it } from "vitest";
import { injectDevApiProxyAuth, type DevProxyHeaderBag } from "./devApiProxyAuth";

function mockReq(initial: Record<string, string> = {}): DevProxyHeaderBag & { headers: Record<string, string> } {
  const headers: Record<string, string> = { ...initial };
  return {
    headers,
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    }
  };
}

describe("injectDevApiProxyAuth", () => {
  it("injects Authorization Bearer when CONSISTENCY_API_TOKEN is set and header absent", () => {
    const req = mockReq();
    injectDevApiProxyAuth(req, { CONSISTENCY_API_TOKEN: " secret-token " });
    expect(req.headers.authorization).toBe("Bearer secret-token");
  });

  it("does not overwrite an existing Authorization header", () => {
    const req = mockReq({ authorization: "Bearer already" });
    injectDevApiProxyAuth(req, { CONSISTENCY_API_TOKEN: "secret-token" });
    expect(req.headers.authorization).toBe("Bearer already");
  });

  it("skips Authorization when token is empty/whitespace", () => {
    const req = mockReq();
    injectDevApiProxyAuth(req, { CONSISTENCY_API_TOKEN: "   " });
    expect(req.headers.authorization).toBeUndefined();
  });

  it("injects desktop control header when set and absent", () => {
    const req = mockReq();
    injectDevApiProxyAuth(req, {
      CONSISTENCY_API_TOKEN: "api",
      CONSISTENCY_DESKTOP_CONTROL_TOKEN: "desk"
    });
    expect(req.headers.authorization).toBe("Bearer api");
    expect(req.headers["x-consistency-desktop-control"]).toBe("desk");
  });

  it("does not overwrite an existing desktop control header", () => {
    const req = mockReq({ "x-consistency-desktop-control": "existing" });
    injectDevApiProxyAuth(req, { CONSISTENCY_DESKTOP_CONTROL_TOKEN: "desk" });
    expect(req.headers["x-consistency-desktop-control"]).toBe("existing");
  });
});
