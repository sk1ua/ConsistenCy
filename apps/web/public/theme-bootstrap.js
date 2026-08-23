// Runs before React so the saved theme is visible on the first paint.
try {
  const theme = localStorage.getItem("consistency.theme.v1") || "system";
  const dark = theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch {
  // Storage can be disabled; the CSS default remains dark.
}
