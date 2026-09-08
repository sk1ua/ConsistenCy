import { Github, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { desktopBridge, openExternalUrl, type DesktopGitHubOAuthBridge } from "../../desktop";
import { useI18n } from "../../i18n";
import { Button } from "../../design-system/Button";

export interface GitHubOauthSignInProps {
  /** True while saved settings await a restart; the new token needs one too. */
  restartPending?: boolean;
  /** One-time token handoff into the Web Device Flow credential save path. */
  onConnected: (token: string) => Promise<void>;
  /** Desktop main-process completion; no token is supplied to the renderer. */
  desktopOAuth?: DesktopGitHubOAuthBridge;
  onDesktopConnected?: (login: string) => Promise<void>;
}

type OauthPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "awaiting"; flowId: string; userCode: string; verificationUri: string; intervalSeconds: number }
  | { phase: "desktop-awaiting" }
  | { phase: "connected"; login?: string }
  | { phase: "failed"; messageKey: string };

const MAX_CONSECUTIVE_POLL_ERRORS = 3;

async function writeClipboard(text: string): Promise<void> {
  // Desktop shell first: navigator.clipboard is unreliable under the custom
  // app protocol, so main owns the OS clipboard through a size-capped IPC.
  const bridge = desktopBridge();
  if (bridge?.copyText) {
    await bridge.copyText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Last resort for non-secure contexts: the legacy execCommand path.
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  try {
    if (!document.execCommand("copy")) throw new Error("execCommand copy failed");
  } finally {
    document.body.removeChild(scratch);
  }
}

/**
 * GitHub OAuth Device Flow sign-in for Settings. The access token crosses this
 * component exactly once (connected poll → onConnected) and is never stored in
 * state, rendered, or logged; polling stops on unmount and on every terminal
 * status. Desktop builds use the product-operated broker when one is baked in;
 * when the broker is absent the desktop falls back to this Device Flow against
 * the embedded local API, exactly like browser deployments.
 */
export function GitHubOauthSignIn({ restartPending, onConnected, desktopOAuth, onDesktopConnected }: GitHubOauthSignInProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<OauthPhase>({ phase: "idle" });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  // StrictMode-safe liveness flag: the setup must re-arm the flag because
  // React dev runs setup → cleanup → setup on mount; a cleanup-only flag
  // would stay false forever and swallow every state update after an await.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const pollLoop = useCallback(async (flowId: string, intervalSeconds: number, errors = 0) => {
    try {
      const result = desktopOAuth
        ? await desktopOAuth.pollDeviceFlow({ flowId })
        : await api.pollGitHubOauthDeviceFlow({ flowId });
      if (!mountedRef.current) return;
      if (result.status === "pending") {
        timerRef.current = window.setTimeout(
          () => void pollLoop(flowId, result.retryAfterSeconds),
          result.retryAfterSeconds * 1_000
        );
        return;
      }
      if (result.status === "connected") {
        setPhase({ phase: "connected", login: result.login });
        try {
          // Web poll responses carry the one-time token for the renderer save
          // path; desktop polls consume it inside main, so only the login
          // crosses here.
          if ("publicReadToken" in result && typeof result.publicReadToken === "string") {
            await onConnected(result.publicReadToken);
          } else {
            await onDesktopConnected?.(result.login);
          }
        } catch {
          if (mountedRef.current) setPhase({ phase: "failed", messageKey: "Could not save settings" });
        }
        return;
      }
      const failureKeys: Record<string, string> = {
        expired: "GitHub sign-in expired. Start again.",
        denied: "Authorization was denied.",
        unavailable: "GitHub sign-in is unavailable."
      };
      setPhase({ phase: "failed", messageKey: failureKeys[result.status] ?? "GitHub sign-in is unavailable." });
    } catch {
      if (!mountedRef.current) return;
      // Transient local/API errors: retry a bounded number of times within the
      // authorization window instead of failing the whole sign-in.
      if (errors + 1 >= MAX_CONSECUTIVE_POLL_ERRORS) {
        setPhase({ phase: "failed", messageKey: "GitHub sign-in is unavailable." });
        return;
      }
      timerRef.current = window.setTimeout(
        () => void pollLoop(flowId, intervalSeconds, errors + 1),
        intervalSeconds * 1_000
      );
    }
  }, [desktopOAuth, onConnected, onDesktopConnected]);

  async function startSignIn(): Promise<void> {
    clearTimer();
    setCopied(false);
    setPhase({ phase: "starting" });
    if (desktopOAuth) {
      setPhase({ phase: "desktop-awaiting" });
      try {
        const result = await desktopOAuth.start();
        if (!mountedRef.current) return;
        if (result.status === "connected") {
          setPhase({ phase: "connected", login: result.login });
          await onDesktopConnected?.(result.login);
          return;
        }
        if (result.status === "device-awaiting") {
          // Brokerless desktop build: main proxies the embedded API's Device
          // Flow and consumes the token; the renderer sees only the code UI.
          setPhase({
            phase: "awaiting",
            flowId: result.flowId,
            userCode: result.userCode,
            verificationUri: result.verificationUri,
            intervalSeconds: result.intervalSeconds
          });
          timerRef.current = window.setTimeout(
            () => void pollLoop(result.flowId, result.intervalSeconds),
            result.intervalSeconds * 1_000
          );
          return;
        }
        if (result.status !== "not_configured") {
          const failureKeys: Record<Exclude<typeof result.status, "connected" | "device-awaiting" | "not_configured">, string> = {
            denied: "Authorization was denied.",
            cancelled: "GitHub sign-in was cancelled.",
            expired: "GitHub sign-in expired. Start again.",
            unavailable: "GitHub sign-in is unavailable."
          };
          setPhase({ phase: "failed", messageKey: failureKeys[result.status] });
          return;
        }
        // not_configured: no product broker and no baked Device Flow client id.
        setPhase({ phase: "failed", messageKey: "This ConsistenCy desktop build has no GitHub sign-in service configured." });
        return;
      } catch {
        if (mountedRef.current) setPhase({ phase: "failed", messageKey: "GitHub sign-in is unavailable." });
        return;
      }
    }
    try {
      const started = await api.startGitHubOauthDeviceFlow();
      if (!mountedRef.current) return;
      setPhase({
        phase: "awaiting",
        flowId: started.flowId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        intervalSeconds: started.intervalSeconds
      });
      timerRef.current = window.setTimeout(
        () => void pollLoop(started.flowId, started.intervalSeconds),
        started.intervalSeconds * 1_000
      );
    } catch {
      if (mountedRef.current) setPhase({ phase: "failed", messageKey: "GitHub sign-in is unavailable." });
    }
  }

  async function cancelSignIn(): Promise<void> {
    clearTimer();
    if (desktopOAuth && phase.phase === "desktop-awaiting") {
      await desktopOAuth.cancel().catch(() => {});
    }
    setPhase({ phase: "idle" });
  }

  function copyUserCode(): void {
    if (phase.phase !== "awaiting") return;
    writeClipboard(phase.userCode).then(() => {
      if (!mountedRef.current) return;
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2_000);
    }).catch(() => {
      if (mountedRef.current) setCopyFailed(true);
    });
  }

  return (
    <div className="setting-field setting-field-wide setting-note" id="setting-github-oauth">
      <Github size={17} />
      <div>
        <strong>{t("GitHub sign-in (OAuth)")}</strong>
        {phase.phase === "idle" && (
          <p>{t("One-click sign-in through github.com. Grants identity and read rate limits only — no repository permissions.")}</p>
        )}
        {phase.phase === "connected" && (
          <p role="status">
            <span className="badge badge-succeeded">{t("Signed in as {login}", { login: phase.login ?? "GitHub" })}</span>
            {restartPending && (
              <span className="github-restart-hint">{t("Restart the runtime to use the new credential.")}</span>
            )}
          </p>
        )}
        {phase.phase === "failed" && (
          <p role="status"><span className="badge badge-failed">{t(phase.messageKey)}</span></p>
        )}
        {phase.phase === "desktop-awaiting" && (
          <div className="github-oauth-pending" role="status">
            <p><LoaderCircle className="spinning" size={13} /> {t("Complete authorization in your browser…")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void cancelSignIn()}>{t("Cancel")}</Button>
          </div>
        )}
        {phase.phase === "awaiting" && (
          <div className="github-oauth-pending" role="status">
            <p>
              {t("Enter this code on GitHub:")}{" "}
              <code className="github-oauth-user-code">{phase.userCode}</code>
              <Button type="button" variant="outline" size="sm" onClick={copyUserCode}>
                {copyFailed ? t("Could not copy — select the code manually") : copied ? t("Copied") : t("Copy code")}
              </Button>
            </p>
            <p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openExternalUrl(phase.verificationUri)}
              >
                {t("Open github.com/login/device")}
              </Button>
              <LoaderCircle className="spinning" size={13} /> {t("Waiting for authorization…")}
            </p>
          </div>
        )}
        <Button
          type="button"
          id="setting-github-oauth-start"
          variant="outline"
          size="sm"
          disabled={phase.phase === "starting" || phase.phase === "awaiting" || phase.phase === "desktop-awaiting"}
          onClick={() => void startSignIn()}
        >
          {phase.phase === "starting" ? <LoaderCircle className="spinning" size={13} /> : <Github size={13} />}
          {t(phase.phase === "starting" ? "Starting…" : "Sign in with GitHub")}
        </Button>
      </div>
    </div>
  );
}
