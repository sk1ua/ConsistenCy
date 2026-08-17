const RELEASE_CHANNELS = new Set(["stable", "beta"]);
const PUBLISH_MODES = new Set(["never", "onTagOrDraft", "always"]);
const TARGETS = new Set(["dir", "nsis", "portable"]);

function resolveDesktopReleasePolicy(environment, version) {
  const requestedTargets = (environment.DESKTOP_TARGETS ?? "dir").split(/\s+/).filter(Boolean);
  const releaseMode = environment.CONSISTENCY_DESKTOP_RELEASE === "true";
  const releaseChannel = environment.CONSISTENCY_DESKTOP_UPDATE_CHANNEL ?? "stable";
  const publishMode = environment.CONSISTENCY_DESKTOP_PUBLISH ?? "never";
  const signingCertificate = environment.WIN_CSC_LINK ?? environment.CSC_LINK;

  if (requestedTargets.length === 0 || requestedTargets.some(target => !TARGETS.has(target))) {
    throw new Error("DESKTOP_TARGETS may contain only dir, nsis, or portable");
  }
  if (!RELEASE_CHANNELS.has(releaseChannel)) {
    throw new Error("CONSISTENCY_DESKTOP_UPDATE_CHANNEL must be stable or beta");
  }
  if (!PUBLISH_MODES.has(publishMode)) {
    throw new Error("CONSISTENCY_DESKTOP_PUBLISH must be never, onTagOrDraft, or always");
  }
  if (releaseChannel === "beta" && !/-beta(?:[.-]|$)/i.test(version)) {
    throw new Error("Beta update artifacts require an app version containing a -beta prerelease tag");
  }
  if (releaseChannel === "stable" && version.includes("-")) {
    throw new Error("Stable update artifacts require a non-prerelease app version");
  }
  if (releaseMode && (typeof signingCertificate !== "string" || signingCertificate.trim() === "")) {
    throw new Error("CONSISTENCY_DESKTOP_RELEASE=true requires WIN_CSC_LINK or CSC_LINK for code signing");
  }
  if (publishMode !== "never" && !releaseMode) {
    throw new Error("Publishing is allowed only when CONSISTENCY_DESKTOP_RELEASE=true");
  }
  if (publishMode !== "never" && !requestedTargets.includes("nsis")) {
    throw new Error("Automatic-update publication requires the nsis target");
  }
  if (publishMode !== "never" && !environment.GH_TOKEN && !environment.GITHUB_TOKEN) {
    throw new Error("GitHub publication requires GH_TOKEN or GITHUB_TOKEN in the release environment");
  }

  return Object.freeze({
    requestedTargets: Object.freeze([...requestedTargets]),
    releaseMode,
    releaseChannel,
    publishMode,
    builderChannel: releaseChannel === "beta" ? "beta" : "latest",
    githubReleaseType: releaseChannel === "beta" ? "prerelease" : "release",
    updateEligibleArtifact: releaseMode && requestedTargets.includes("nsis")
  });
}

module.exports = Object.freeze({ resolveDesktopReleasePolicy });
