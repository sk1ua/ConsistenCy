import { Github, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubOauthDevicePollResponse } from "@consistency/schema";
import { api } from "../../api/client";
import { openExternalUrl } from "../../desktop";
import { useI18n } from "../../i18n";

export interface GitHubOauthSignInProps {
  /** ACTIVE configured OAuth App client id; empty disables sign-in honestly. */
  oauthClientId: string;
  /** True while saved settings await a restart; the new token needs one too. */
  restartPending?: boolean;
  /** One-time token handoff into the existing credential save path. */
  onConnected: (token: string) => Promise<void>;
}

type OauthPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "awaiting"; flowId: string; userCode: string; verificationUri: string; intervalSeconds: number }
  | { phase: "connected"; login: string }
  | { phase: "failed"; messageKey: string };

const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/**
 * GitHub OAuth Device Flow sign-in for Settings. The access token crosses this
 * component exactly once (connected poll → onConnected) and is never stored in
 * state, rendered, or logged; polling stops on unmount and on every terminal
 * status. Unconfigured client ids render an honest setup hint instead of a
 * broken button.
 */
export function GitHubOauthSignIn({ oauthClientId, restartPending, onConnected }: GitHubOauthSignInProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<OauthPhase>({ phase: "idle" });
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    clearTimer();
  }, [clearTimer]);

  const pollLoop = useCallback(async (flowId: string, intervalSeconds: number, errors = 0) => {
    try {
      const result: GitHubOauthDevicePollResponse = await api.pollGitHubOauthDeviceFlow({ flowId });
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
          await onConnected(result.publicReadToken);
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
  }, [onConnected]);

  async function startSignIn(): Promise<void> {
    clearTimer();
    setCopied(false);
    setPhase({ phase: "starting" });
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

  function copyUserCode(): void {
    if (phase.phase !== "awaiting") return;
    void navigator.clipboard?.writeText(phase.userCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }).catch(() => {});
  }

  if (oauthClientId.trim() === "") {
    return (
      <div className="setting-field setting-field-wide setting-note" id="setting-github-oauth-setup">
        <Github size={17} />
        <div>
          <strong>{t("GitHub sign-in (OAuth)")}</strong>
          <p>
            {t("Configure an OAuth App client ID below and restart to enable one-click GitHub sign-in — no personal token required.")}
          </p>
        </div>
      </div>
    );
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
            <span className="badge badge-succeeded">{t("Signed in as {login}", { login: phase.login })}</span>
            {restartPending && (
              <span className="github-restart-hint">{t("Restart the runtime to use the new credential.")}</span>
            )}
          </p>
        )}
        {phase.phase === "failed" && (
          <p role="status"><span className="badge badge-failed">{t(phase.messageKey)}</span></p>
        )}
        {phase.phase === "awaiting" && (
          <div className="github-oauth-pending" role="status">
            <p>
              {t("Enter this code on GitHub:")}{" "}
              <code className="github-oauth-user-code">{phase.userCode}</code>
              <button type="button" className="secondary-button" onClick={copyUserCode}>
                {copied ? t("Copied") : t("Copy code")}
              </button>
            </p>
            <p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => openExternalUrl(phase.verificationUri)}
              >
                {t("Open github.com/login/device")}
              </button>
              <LoaderCircle className="spinning" size={13} /> {t("Waiting for authorization…")}
            </p>
          </div>
        )}
        <button
          type="button"
          id="setting-github-oauth-start"
          className="secondary-button"
          disabled={phase.phase === "starting" || phase.phase === "awaiting"}
          onClick={() => void startSignIn()}
        >
          {phase.phase === "starting" ? <LoaderCircle className="spinning" size={13} /> : <Github size={13} />}
          {t(phase.phase === "starting" ? "Starting…" : "Sign in with GitHub")}
        </button>
      </div>
    </div>
  );
}
