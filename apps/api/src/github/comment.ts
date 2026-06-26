import { Octokit } from "@octokit/rest";
import { splitRepositoryFullName } from "./client";

export type PublishComment = (input: {
  repositoryFullName: string;
  pullRequestNumber: number;
  token: string;
  body: string;
}) => Promise<void>;

export const publishPullRequestComment: PublishComment = async input => {
  const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
  const octokit = new Octokit({ auth: input.token });
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: input.pullRequestNumber,
    body: input.body
  });
};
