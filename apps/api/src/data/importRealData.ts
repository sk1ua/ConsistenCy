import { importRealData } from "./realData";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repository = argument("--repo");
const pullRequest = argument("--pr");
const reportPath = argument("--report");
const result = await importRealData({
  repository,
  pullRequestNumber: pullRequest ? Number(pullRequest) : undefined,
  reportPath
});

console.log(JSON.stringify({
  imported: true,
  source: result.source.url,
  commits: result.source.commits,
  changedFiles: result.source.changedFiles,
  analysisReport: result.analysis.reportPath,
  shaVerified: true,
  validationSample: `${result.validation.evaluatedCount}/${result.validation.sampleCount}`
}, null, 2));
