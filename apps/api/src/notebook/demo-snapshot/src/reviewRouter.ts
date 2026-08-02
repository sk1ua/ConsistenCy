export function reviewRouter(input: { authenticated: boolean; changedFiles: string[] }): string {
  if (!input.authenticated) return "review requires authentication";
  return input.changedFiles.join(",");
}

export function changedModuleCount(input: { changedFiles: string[] }): number {
  return new Set(input.changedFiles.map(file => file.split("/")[0])).size;
}
