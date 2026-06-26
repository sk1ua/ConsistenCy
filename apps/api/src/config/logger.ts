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
  "config.DEEPSEEK_API_KEY",
  "config.OPENAI_API_KEY"
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: secretPaths,
      censor: "[REDACTED]"
    },
    ...options
  });
}

export const logger = createLogger();

