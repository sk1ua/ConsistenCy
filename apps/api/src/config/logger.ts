import pino, { type Logger, type LoggerOptions } from "pino";

const secretPaths = [
  "apiKey",
  "token",
  "accessToken",
  "authorization",
  "headers.authorization",
  "config.CONSISTENCY_API_TOKEN",
  "config.GITHUB_PRIVATE_KEY",
  "config.GITHUB_WEBHOOK_SECRET",
  "config.GITHUB_PUBLIC_READ_TOKEN",
  "config.DEEPSEEK_API_KEY",
  "config.OPENAI_API_KEY"
];

/**
 * Structured logs always go to STDERR.
 *
 * stdout is a data channel, not a log sink: `consistency review --json` prints
 * its report there and must stay directly parseable (`... --json | jq`). A
 * stderr destination also keeps the API daemon's stdout free for callers that
 * pipe it.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: secretPaths,
        censor: "[REDACTED]"
      },
      ...options
    },
    pino.destination({ dest: 2, sync: true })
  );
}

export const logger = createLogger();

