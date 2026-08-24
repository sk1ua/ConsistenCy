import { QueryClient } from "@tanstack/react-query";

export const workspaceQueryKeys = {
  all: ["workspace"] as const,
  jobs: ["workspace", "jobs"] as const,
  job: (jobId: string) => ["workspace", "jobs", jobId] as const,
  reports: ["workspace", "reports"] as const,
  report: (jobId: string) => ["workspace", "reports", jobId] as const,
  notebook: (jobId: string) => ["workspace", "notebooks", jobId] as const,
  stats: ["workspace", "stats"] as const,
  health: ["workspace", "health"] as const,
  auditCapabilities: ["workspace", "audit-capabilities"] as const,
  repositories: ["workspace", "repositories"] as const,
  repositoryTimeline: (repositoryId: string) => ["workspace", "repositories", repositoryId, "timeline"] as const,
  repositoryMetrics: (repositoryId: string) => ["workspace", "repositories", repositoryId, "metrics"] as const,
  repositoryIssues: (repositoryId: string) => ["workspace", "repositories", repositoryId, "issues"] as const,
  repositoryGitStatus: (repositoryId: string) => ["workspace", "repositories", repositoryId, "git-status"] as const,
  repositoryCommits: (repositoryId: string) => ["workspace", "repositories", repositoryId, "commits"] as const,
  repositoryReviews: (repositoryId: string) => ["workspace", "repositories", repositoryId, "reviews"] as const,
  repositoryPullRequests: (repositoryId: string) => ["workspace", "repositories", repositoryId, "pull-requests"] as const,
  automations: ["workspace", "automations"] as const,
  runtimeRuns: ["workspace", "runtime-runs"] as const,
  runtimeSnapshot: (runId: string) => ["workspace", "runtime-snapshot", runId] as const
};

export function createWorkspaceQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false
      },
      mutations: {
        retry: 0
      }
    }
  });
}

export const workspaceQueryClient = createWorkspaceQueryClient();
