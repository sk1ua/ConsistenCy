export type GitHubInstallationAuthenticator = {
  getRepositoryInstallationId(owner: string, repo: string): Promise<number>;
  getInstallationToken(installationId: number): Promise<{ readonly token: string }>;
};

export type GitHubReadAccessCandidate = {
  readonly token?: string;
};

export async function resolveGitHubReadAccessCandidates(options: {
  readonly owner: string;
  readonly repo: string;
  readonly authenticator?: GitHubInstallationAuthenticator;
  readonly publicReadToken?: string;
}): Promise<readonly GitHubReadAccessCandidate[]> {
  const candidates: GitHubReadAccessCandidate[] = [];
  const addToken = (token?: string): void => {
    if (!candidates.some(candidate => candidate.token === token)) candidates.push(token === undefined ? {} : { token });
  };

  if (options.authenticator !== undefined) {
    try {
      const installationId = await options.authenticator.getRepositoryInstallationId(options.owner, options.repo);
      const installation = await options.authenticator.getInstallationToken(installationId);
      addToken(installation.token);
    } catch {
      // App access is optional; continue to configured PAT and anonymous reads.
    }
  }
  if (options.publicReadToken !== undefined) addToken(options.publicReadToken);
  addToken();
  return candidates;
}
