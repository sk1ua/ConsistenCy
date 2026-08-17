import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { workspaceQueryKeys } from "./client";

export function useWorkspaceQueries() {
  const jobs = useQuery({
    queryKey: workspaceQueryKeys.jobs,
    queryFn: ({ signal }) => api.jobs({}, signal),
    refetchInterval: 10_000
  });
  const reports = useQuery({
    queryKey: workspaceQueryKeys.reports,
    queryFn: ({ signal }) => api.recentReports(20, signal),
    refetchInterval: 30_000
  });
  const stats = useQuery({
    queryKey: workspaceQueryKeys.stats,
    queryFn: ({ signal }) => api.stats(signal),
    refetchInterval: 30_000
  });
  const health = useQuery({
    queryKey: workspaceQueryKeys.health,
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 15_000
  });
  const auditCapabilities = useQuery({
    queryKey: workspaceQueryKeys.auditCapabilities,
    queryFn: ({ signal }) => api.auditCapabilities(signal),
    staleTime: 60_000
  });
  const repositories = useQuery({
    queryKey: workspaceQueryKeys.repositories,
    queryFn: ({ signal }) => api.repositories(signal),
    refetchInterval: 15_000
  });
  const automations = useQuery({
    queryKey: workspaceQueryKeys.automations,
    queryFn: ({ signal }) => api.automations(signal),
    refetchInterval: 15_000
  });

  const refresh = useCallback(async () => {
    await Promise.allSettled([
      jobs.refetch(),
      reports.refetch(),
      stats.refetch(),
      health.refetch(),
      auditCapabilities.refetch(),
      repositories.refetch(),
      automations.refetch()
    ]);
  }, [auditCapabilities.refetch, automations.refetch, health.refetch, jobs.refetch, reports.refetch, repositories.refetch, stats.refetch]);

  return {
    jobs,
    reports,
    stats,
    health,
    auditCapabilities,
    repositories,
    automations,
    refresh,
    isFetching: jobs.isFetching || reports.isFetching || stats.isFetching || health.isFetching || auditCapabilities.isFetching || repositories.isFetching || automations.isFetching
  };
}
