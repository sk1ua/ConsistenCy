/**
 * `consistency` — terminal entry point.
 *
 * Dispatch stays as small as `apps/api/src/config/cli.ts:128` in spirit: one
 * hand-rolled command table, no framework. Exit codes are the contract CI
 * depends on, so they are set in exactly one place per outcome:
 *   0  review ran, nothing met the threshold
 *   1  review ran, the threshold was met
 *   2  the review did not run, or its coverage was incomplete
 */

import { REVIEW_USAGE, UsageError, parseReviewOptions } from "./args";
import { ReviewSetupError, createCommandIO, runReview } from "./review";

const PROGRAM_USAGE = `consistency — ConsistenCy 终端入口

用法
  consistency review [选项]    在当前仓库上运行一次真实审查
  consistency help             显示本帮助

运行 \`consistency review --help\` 查看审查选项。
`;

function exitCodeForError(error: unknown): 2 {
  // Every failure here means "the review did not run", which exit code 2
  // exists to distinguish from "ran and found nothing" (0).
  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command = "help", ...rest] = argv;

  switch (command) {
    case "review": {
      if (rest.includes("--help") || rest.includes("-h")) {
        process.stdout.write(REVIEW_USAGE);
        return 0;
      }
      const options = parseReviewOptions(rest);
      const io = createCommandIO(options);
      return await runReview(options, io);
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(PROGRAM_USAGE);
      return 0;
    default:
      process.stderr.write(`未知命令：${command}\n\n${PROGRAM_USAGE}`);
      return 2;
  }
}

/**
 * Only these two are expected failures with a message meant for a human. A
 * stack trace here would bury the one line that says what to fix.
 */
function isExpected(error: unknown): boolean {
  return error instanceof UsageError || error instanceof ReviewSetupError;
}

main(process.argv.slice(2))
  .then(code => { process.exitCode = code; })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isExpected(error)) {
      if (message !== "") process.stderr.write(`${message}\n`);
      if (error instanceof UsageError) process.stderr.write(`\n${REVIEW_USAGE}`);
      process.exitCode = exitCodeForError(error);
      return;
    }
    process.stderr.write(`${message}\n`);
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = exitCodeForError(error);
  });
