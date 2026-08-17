const LEGACY_VIEWS = new Set(["dashboard", "jobs", "report", "workflows", "settings"]);

export function legacyRouteFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const jobId = params.get("job");
  const notebookId = params.get("notebook");
  if (!view && !jobId && !notebookId) return null;
  if (view && !LEGACY_VIEWS.has(view)) return null;

  let route = "/inbox";
  if (view === "jobs") route = "/runs";
  if (view === "report" || jobId || notebookId) {
    route = jobId ? `/runs/${encodeURIComponent(jobId)}/${notebookId ? "notebook" : "overview"}` : "/runs";
    if (notebookId) route += `?notebook=${encodeURIComponent(notebookId)}`;
  }
  if (view === "workflows") route = "/workflows";
  if (view === "settings") route = "/settings";
  return route;
}

type LocationLike = Pick<Location, "hash" | "pathname" | "search">;
type HistoryLike = Pick<History, "replaceState">;

export function migrateLegacyLocation(
  locationLike: LocationLike = window.location,
  historyLike: HistoryLike = window.history
): boolean {
  if (locationLike.hash && locationLike.hash !== "#" && locationLike.hash !== "#/") return false;
  const route = legacyRouteFromSearch(locationLike.search);
  if (!route) return false;

  const remaining = new URLSearchParams(locationLike.search);
  remaining.delete("view");
  remaining.delete("job");
  remaining.delete("notebook");
  const search = remaining.size > 0 ? `?${remaining.toString()}` : "";
  historyLike.replaceState(null, "", `${locationLike.pathname}${search}#${route}`);
  return true;
}
