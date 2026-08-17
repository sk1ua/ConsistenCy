import { useEffect, useState } from "react";
import type { JobDiffResponse, VcsChangedFile } from "@consistency/schema";
import { api } from "../api/client";

export type JobDiffState =
  | { status: "idle" }
  | { status: "loading"; jobId: string }
  | { status: "available"; jobId: string; files: VcsChangedFile[] }
  | { status: "unavailable"; jobId: string }
  | { status: "error"; jobId: string; message: string };

type JobDiffClient = Pick<typeof api, "jobDiff">;

export async function loadJobDiff(jobId: string, client: JobDiffClient = api, signal?: AbortSignal): Promise<JobDiffState> {
  try {
    const response: JobDiffResponse = await client.jobDiff(jobId, signal);
    if (response.jobId !== jobId) {
      return { status: "error", jobId, message: "The diff response did not belong to the selected job." };
    }
    return response.available
      ? { status: "available", jobId, files: response.files }
      : { status: "unavailable", jobId };
  } catch (error) {
    return {
      status: "error",
      jobId,
      message: error instanceof Error ? error.message : "Could not load the selected job diff."
    };
  }
}

export function useJobDiff(jobId?: string): JobDiffState {
  const [state, setState] = useState<JobDiffState>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    if (!jobId) {
      setState({ status: "idle" });
      return () => controller.abort();
    }

    setState({ status: "loading", jobId });
    void loadJobDiff(jobId, api, controller.signal).then(next => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [jobId]);

  return state;
}
