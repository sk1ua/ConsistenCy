import { describe, expect, it } from "vitest";
import { createDeviceFlowProxy } from "./device-flow.cjs";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

type ApiCall = { path: string; init: RequestInit };

function createHarness(options?: {
  hasClientId?: boolean;
  apiResponse?: () => Response;
  apiThrows?: boolean;
  writeCredential?: (key: string, value: string) => Promise<void>;
}) {
  const calls: Array<ApiCall> = [];
  const writtenCredentials: Array<{ key: string; value: string }> = [];
  const proxy = createDeviceFlowProxy({
    apiFetch: async (path: string, init: RequestInit = {}) => {
      if (options?.apiThrows) throw new Error("api helper is down");
      calls.push({ path, init });
      return (options?.apiResponse ?? (() => jsonResponse({})))();
    },
    writeCredential: async (key: string, value: string) => {
      if (options?.writeCredential) return options.writeCredential(key, value);
      writtenCredentials.push({ key, value });
    },
    hasClientId: () => options?.hasClientId ?? true
  });
  return { proxy, calls, writtenCredentials };
}

describe("device flow proxy", () => {
  it("reports not_configured without any client id and never calls the API", async () => {
    const { proxy, calls } = createHarness({ hasClientId: false });
    expect(await proxy.start()).toEqual({ status: "not_configured" });
    expect(calls).toEqual([]);
  });

  it("starts a flow and returns only public code fields to the renderer", async () => {
    const { proxy, calls } = createHarness({
      apiResponse: () => jsonResponse({
        flowId: "flow-1",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5
      })
    });
    const result = await proxy.start();
    expect(result).toEqual({
      status: "device-awaiting",
      flowId: "flow-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5
    });
    expect(calls).toEqual([{ path: "/settings/github/oauth/start", init: { method: "POST" } }]);
  });

  it("maps a failed or malformed start to a fixed unavailable status", async () => {
    const failed = createHarness({ apiResponse: () => jsonResponse({}, 503) });
    expect(await failed.proxy.start()).toEqual({ status: "unavailable" });

    const malformed = createHarness({ apiResponse: () => jsonResponse({ flowId: 7 }) });
    expect(await malformed.proxy.start()).toEqual({ status: "unavailable" });

    const down = createHarness({ apiThrows: true });
    expect(await down.proxy.start()).toEqual({ status: "unavailable" });
  });

  it("polls pending without ever seeing a credential", async () => {
    const { proxy, calls } = createHarness({
      apiResponse: () => jsonResponse({ status: "pending", retryAfterSeconds: 7 })
    });
    expect(await proxy.poll({ flowId: "flow-1" })).toEqual({ status: "pending", retryAfterSeconds: 7 });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ flowId: "flow-1" }));
  });

  it("consumes the one-time token into safeStorage and returns only the login", async () => {
    const { proxy, writtenCredentials } = createHarness({
      apiResponse: () => jsonResponse({
        status: "connected",
        login: "octocat",
        publicReadToken: "gho_test_secret"
      })
    });
    const result = await proxy.poll({ flowId: "flow-1" });
    expect(result).toEqual({ status: "connected", login: "octocat" });
    expect(JSON.stringify(result)).not.toContain("gho_test_secret");
    expect(writtenCredentials).toEqual([{ key: "GITHUB_PUBLIC_READ_TOKEN", value: "gho_test_secret" }]);
  });

  it("maps a credential write failure to unavailable instead of leaking a partial state", async () => {
    const { proxy } = createHarness({
      apiResponse: () => jsonResponse({
        status: "connected",
        login: "octocat",
        publicReadToken: "gho_test_secret"
      }),
      writeCredential: async () => {
        throw new Error("safeStorage is unavailable");
      }
    });
    expect(await proxy.poll({ flowId: "flow-1" })).toEqual({ status: "unavailable" });
  });

  it("passes through denied and expired statuses and rejects malformed poll input", async () => {
    const denied = createHarness({ apiResponse: () => jsonResponse({ status: "denied" }) });
    expect(await denied.proxy.poll({ flowId: "flow-1" })).toEqual({ status: "denied" });

    const expired = createHarness({ apiResponse: () => jsonResponse({ status: "expired" }) });
    expect(await expired.proxy.poll({ flowId: "flow-1" })).toEqual({ status: "expired" });

    const { proxy } = createHarness();
    for (const input of [undefined, {}, { flowId: 7 }, { flowId: "" }, { flowId: "x".repeat(257) }]) {
      expect(await proxy.poll(input as { flowId: string })).toEqual({ status: "unavailable" });
    }
  });

  it("maps a malformed connected payload to unavailable without writing credentials", async () => {
    const { proxy, writtenCredentials } = createHarness({
      apiResponse: () => jsonResponse({ status: "connected", login: "octocat" })
    });
    expect(await proxy.poll({ flowId: "flow-1" })).toEqual({ status: "unavailable" });
    expect(writtenCredentials).toEqual([]);
  });

  it("refuses to be created without its main-process dependencies", () => {
    expect(() => createDeviceFlowProxy({} as Parameters<typeof createDeviceFlowProxy>[0])).toThrow("Device Flow proxy requires apiFetch, writeCredential and hasClientId");
  });
});
