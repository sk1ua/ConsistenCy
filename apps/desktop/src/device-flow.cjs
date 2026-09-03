"use strict";

// Device Flow fallback for Desktop builds without a product broker: the
// embedded API owns the GitHub protocol while main owns the polling and the
// credential, so the access token never crosses into the renderer. main.cjs
// wires apiFetch (authenticated loopback calls) and writeCredential
// (safeStorage) into this module; everything here stays pure and unit-testable.

function createDeviceFlowProxy(input) {
  const { apiFetch, writeCredential, hasClientId } = input;
  if (typeof apiFetch !== "function" || typeof writeCredential !== "function" || typeof hasClientId !== "function") {
    throw new Error("Device Flow proxy requires apiFetch, writeCredential and hasClientId");
  }

  async function start() {
    if (!hasClientId()) return { status: "not_configured" };
    let response;
    try {
      response = await apiFetch("/settings/github/oauth/start", { method: "POST" });
    } catch {
      return { status: "unavailable" };
    }
    if (!response.ok) return { status: "unavailable" };
    try {
      const payload = await response.json();
      if (typeof payload?.flowId !== "string" || typeof payload?.userCode !== "string" || typeof payload?.verificationUri !== "string" || !Number.isInteger(payload?.intervalSeconds)) {
        return { status: "unavailable" };
      }
      return {
        status: "device-awaiting",
        flowId: payload.flowId,
        userCode: payload.userCode,
        verificationUri: payload.verificationUri,
        intervalSeconds: payload.intervalSeconds
      };
    } catch {
      return { status: "unavailable" };
    }
  }

  async function poll(input) {
    if (!input || typeof input.flowId !== "string" || input.flowId.length > 256) return { status: "unavailable" };
    let response;
    try {
      response = await apiFetch("/settings/github/oauth/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: input.flowId })
      });
    } catch {
      return { status: "unavailable" };
    }
    if (!response.ok) return { status: "unavailable" };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { status: "unavailable" };
    }
    if (payload?.status === "pending" && Number.isInteger(payload?.retryAfterSeconds)) {
      return { status: "pending", retryAfterSeconds: payload.retryAfterSeconds };
    }
    if (payload?.status === "connected" && typeof payload?.login === "string" && typeof payload?.publicReadToken === "string") {
      try {
        await writeCredential("GITHUB_PUBLIC_READ_TOKEN", payload.publicReadToken);
      } catch {
        return { status: "unavailable" };
      }
      // The token is consumed here and must never appear in the result.
      return { status: "connected", login: payload.login };
    }
    if (payload?.status === "denied" || payload?.status === "expired") return { status: payload.status };
    return { status: "unavailable" };
  }

  return { start, poll };
}

module.exports = { createDeviceFlowProxy };
