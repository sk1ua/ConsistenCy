import { z } from "zod";

const cleanTokenText = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const base64UrlToken = (min: number, max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`));

export const desktopOAuthCallbackUrlSchema = z.string().url().max(512).superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "callbackUrl must be a valid URL" });
    return;
  }
  const port = parsed.port ? Number(parsed.port) : 0;
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || parsed.pathname !== "/oauth/callback"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "callbackUrl must be an HTTP 127.0.0.1 URL with the exact /oauth/callback path"
    });
  }
});

export const desktopOAuthStartRequestSchema = z.object({
  callbackUrl: desktopOAuthCallbackUrlSchema,
  state: base64UrlToken(32, 256),
  codeChallenge: base64UrlToken(43, 128),
  codeChallengeMethod: z.literal("S256")
}).strict();

export const desktopOAuthStartResponseSchema = z.object({
  flowId: base64UrlToken(16, 256),
  authorizeUrl: z.string().url().max(2_048).superRefine((value, context) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.pathname !== "/login/oauth/authorize") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "authorizeUrl must be GitHub's HTTPS authorization endpoint" });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "authorizeUrl must be a valid URL" });
    }
  })
}).strict();

export const desktopOAuthCompleteRequestSchema = z.object({
  flowId: base64UrlToken(16, 256),
  code: cleanTokenText(512),
  codeVerifier: base64UrlToken(43, 128)
}).strict();

export const desktopOAuthCompleteResponseSchema = z.object({
  status: z.literal("connected"),
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/).max(39),
  accessToken: cleanTokenText(4_096)
}).strict();

export const desktopOAuthCancelRequestSchema = z.object({
  flowId: base64UrlToken(16, 256)
}).strict();

export const desktopOAuthCancelResponseSchema = z.object({
  status: z.literal("cancelled")
}).strict();

export type DesktopOAuthStartRequest = z.infer<typeof desktopOAuthStartRequestSchema>;
export type DesktopOAuthStartResponse = z.infer<typeof desktopOAuthStartResponseSchema>;
export type DesktopOAuthCompleteRequest = z.infer<typeof desktopOAuthCompleteRequestSchema>;
export type DesktopOAuthCompleteResponse = z.infer<typeof desktopOAuthCompleteResponseSchema>;
