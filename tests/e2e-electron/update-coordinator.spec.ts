import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const updates = require(resolve(repositoryRoot, "apps", "desktop", "src", "update-coordinator.cjs")) as {
  determineUpdateEligibility: (input: {
    isPackaged: boolean;
    platform: string;
    isPortable: boolean;
    nsisInstalled: boolean;
    signedRelease: boolean;
    updateEnabled: boolean;
  }) => { mode: "automatic" | "manual"; reason: string };
  createUpdateCoordinator: (input: Record<string, unknown>) => {
    getState: () => Record<string, unknown>;
    setChannel: (channel: string) => Promise<Record<string, unknown>>;
    check: () => Promise<Record<string, unknown>>;
    download: () => Promise<Record<string, unknown>>;
    install: () => Record<string, unknown>;
    dispose: () => void;
  };
};
const releasePolicy = require(resolve(repositoryRoot, "apps", "desktop", "scripts", "release-policy.cjs")) as {
  resolveDesktopReleasePolicy: (environment: Record<string, string | undefined>, version: string) => {
    requestedTargets: readonly string[];
    releaseMode: boolean;
    releaseChannel: "stable" | "beta";
    publishMode: string;
    builderChannel: "latest" | "beta";
    githubReleaseType: "release" | "prerelease";
    updateEligibleArtifact: boolean;
  };
};

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableWebInstaller = false;
  allowPrerelease = false;
  allowDowngrade = true;
  channel: string | null = null;
  checks = 0;
  downloads = 0;
  installs = 0;
  checkResult: unknown = { isUpdateAvailable: false, updateInfo: { version: "1.0.0" } };

  async checkForUpdates() {
    this.checks += 1;
    return this.checkResult;
  }

  async downloadUpdate() {
    this.downloads += 1;
    return ["C:\\private\\updater-cache\\ConsistenCy Setup.exe"];
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

function automaticEligibility() {
  return updates.determineUpdateEligibility({
    isPackaged: true,
    platform: "win32",
    isPortable: false,
    nsisInstalled: true,
    signedRelease: true,
    updateEnabled: true
  });
}

test.describe("desktop update coordinator", () => {
  test("permits automation only for a signed, installed NSIS release", () => {
    expect(automaticEligibility()).toEqual({ mode: "automatic", reason: "ready" });
    expect(updates.determineUpdateEligibility({
      isPackaged: false,
      platform: "win32",
      isPortable: false,
      nsisInstalled: false,
      signedRelease: false,
      updateEnabled: false
    })).toEqual({ mode: "manual", reason: "development" });
    expect(updates.determineUpdateEligibility({
      isPackaged: true,
      platform: "win32",
      isPortable: true,
      nsisInstalled: true,
      signedRelease: true,
      updateEnabled: true
    })).toEqual({ mode: "manual", reason: "portable" });
    expect(updates.determineUpdateEligibility({
      isPackaged: true,
      platform: "win32",
      isPortable: false,
      nsisInstalled: false,
      signedRelease: true,
      updateEnabled: true
    })).toEqual({ mode: "manual", reason: "not-installed" });
    expect(updates.determineUpdateEligibility({
      isPackaged: true,
      platform: "win32",
      isPortable: false,
      nsisInstalled: true,
      signedRelease: false,
      updateEnabled: true
    })).toEqual({ mode: "manual", reason: "unsigned" });
    expect(updates.determineUpdateEligibility({
      isPackaged: true,
      platform: "win32",
      isPortable: false,
      nsisInstalled: true,
      signedRelease: true,
      updateEnabled: false
    })).toEqual({ mode: "manual", reason: "release-disabled" });
  });

  test("keeps development and portable builds manual-only without invoking updater operations", async () => {
    const updater = new FakeUpdater();
    const coordinator = updates.createUpdateCoordinator({
      eligibility: { mode: "manual", reason: "portable" },
      updater,
      initialChannel: "stable",
      currentVersion: "0.1.0",
      signedRelease: true
    });

    expect(coordinator.getState()).toEqual({
      mode: "manual",
      reason: "portable",
      channel: "stable",
      phase: "manual-only",
      currentVersion: "0.1.0",
      signedRelease: true,
      message: "Portable builds use manual updates."
    });
    expect((await coordinator.check()).ok).toBe(false);
    expect((await coordinator.download()).ok).toBe(false);
    expect(coordinator.install().ok).toBe(false);
    expect({ checks: updater.checks, downloads: updater.downloads, installs: updater.installs })
      .toEqual({ checks: 0, downloads: 0, installs: 0 });
  });

  test("defaults to stable, maps beta explicitly, and never enables downgrade", async () => {
    const updater = new FakeUpdater();
    const persisted: string[] = [];
    const coordinator = updates.createUpdateCoordinator({
      eligibility: automaticEligibility(),
      updater,
      initialChannel: "not-a-channel",
      currentVersion: "1.2.3",
      signedRelease: true,
      persistChannel: async (channel: string) => { persisted.push(channel); }
    });

    expect(coordinator.getState()).toMatchObject({ mode: "automatic", channel: "stable", phase: "idle" });
    expect(updater.channel).toBe("latest");
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);

    expect((await coordinator.setChannel("nightly")).ok).toBe(false);
    expect((await coordinator.setChannel("beta")).ok).toBe(true);
    expect(persisted).toEqual(["beta"]);
    expect(updater.channel).toBe("beta");
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });

  test("returns only whitelisted status while discarding URLs, tokens, paths and raw errors", async () => {
    const updater = new FakeUpdater();
    const observed: unknown[] = [];
    const coordinator = updates.createUpdateCoordinator({
      eligibility: automaticEligibility(),
      updater,
      initialChannel: "beta",
      currentVersion: "1.2.3",
      signedRelease: true,
      notify: (state: unknown) => { observed.push(state); }
    });

    updater.emit("update-available", {
      version: "2.0.0-beta.1",
      files: [{ url: "https://updates.example/private?token=secret" }],
      installerPath: "C:\\private\\update.exe"
    });
    expect(coordinator.getState()).toMatchObject({
      phase: "available",
      availableVersion: "2.0.0-beta.1"
    });

    const downloadResult = await coordinator.download();
    updater.emit("download-progress", {
      percent: 41.234,
      path: "C:\\private\\update.exe",
      feedUrl: "https://updates.example/private?token=secret"
    });
    updater.emit("update-downloaded", {
      version: "2.0.0-beta.1",
      downloadedFile: "C:\\private\\update.exe"
    });
    expect(downloadResult.ok).toBe(true);
    expect(coordinator.getState()).toMatchObject({ phase: "downloaded", progressPercent: 100 });
    expect(coordinator.install().ok).toBe(true);
    expect(updater.installs).toBe(1);

    updater.emit("error", new Error("token=secret C:\\private\\update.exe https://updates.example"));
    const serialized = JSON.stringify({ state: coordinator.getState(), observed, downloadResult });
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("C:\\\\private");
    expect(serialized).not.toContain("updates.example");
    expect(serialized).not.toContain("Setup.exe");
    expect(coordinator.getState()).toMatchObject({
      phase: "error",
      message: "The update service is unavailable. Try again later."
    });
  });

  test("keeps release configuration explicit and updater credentials out of preload", () => {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "apps", "desktop", "package.json"), "utf8"));
    const preload = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "preload.cjs"), "utf8");
    const main = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "main.cjs"), "utf8");
    const afterPack = readFileSync(resolve(repositoryRoot, "apps", "desktop", "scripts", "afterPack.cjs"), "utf8");
    const installer = readFileSync(resolve(repositoryRoot, "apps", "desktop", "scripts", "installer.nsh"), "utf8");
    const releasePolicySource = readFileSync(resolve(repositoryRoot, "apps", "desktop", "scripts", "release-policy.cjs"), "utf8");
    const packer = readFileSync(resolve(repositoryRoot, "scripts", "desktop-pack.mjs"), "utf8");

    expect(manifest.dependencies["electron-updater"]).toBe("6.8.9");
    expect(manifest.consistencyDesktopSignedRelease).toBe(false);
    expect(manifest.consistencyDesktopUpdateChannel).toBe("stable");
    expect(manifest.build.asar).toBe(true);
    expect(manifest.build.afterPack).toBe("scripts/afterPack.cjs");
    expect(manifest.build.forceCodeSigning).toBe(false);
    expect(manifest.build.electronUpdaterCompatibility).toBe(">= 2.16");
    expect(manifest.build.generateUpdatesFilesForAllChannels).toBe(true);
    expect(manifest.build.publish[0]).toMatchObject({
      provider: "github",
      owner: "sk1ua",
      repo: "ConsistenCy",
      channel: "latest",
      releaseType: "release"
    });
    expect(manifest.build.nsis.artifactName).not.toBe(manifest.build.portable.artifactName);
    expect(afterPack).toContain("EnableEmbeddedAsarIntegrityValidation");
    expect(afterPack).toContain("OnlyLoadAppFromAsar");
    expect(installer).toContain(".consistency-nsis-installed");
    expect(releasePolicySource).toContain("CONSISTENCY_DESKTOP_RELEASE=true requires WIN_CSC_LINK or CSC_LINK");
    expect(packer).toContain("-c.forceCodeSigning=");
    expect(packer).toContain('"--publish",\n  publishMode');
    expect(releasePolicySource).toContain("Publishing is allowed only when CONSISTENCY_DESKTOP_RELEASE=true");
    for (const handler of [
      "updates:get-state",
      "updates:set-channel",
      "updates:check",
      "updates:download",
      "updates:install"
    ]) {
      const start = main.indexOf(`ipcMain.handle("${handler}"`);
      expect(start, handler).toBeGreaterThan(-1);
      expect(main.slice(start, start + 180), handler).toContain("assertTrustedSender(event)");
    }
    expect(preload).not.toMatch(/feedUrl|setFeedURL|requestHeaders|CSC_LINK|GH_TOKEN/);
  });

  test("fails release publication closed unless signing, target, channel and token agree", () => {
    expect(releasePolicy.resolveDesktopReleasePolicy({}, "1.2.3")).toEqual({
      requestedTargets: ["dir"],
      releaseMode: false,
      releaseChannel: "stable",
      publishMode: "never",
      builderChannel: "latest",
      githubReleaseType: "release",
      updateEligibleArtifact: false
    });
    expect(() => releasePolicy.resolveDesktopReleasePolicy({
      DESKTOP_TARGETS: "nsis",
      CONSISTENCY_DESKTOP_RELEASE: "true"
    }, "1.2.3")).toThrow(/WIN_CSC_LINK or CSC_LINK/);
    expect(() => releasePolicy.resolveDesktopReleasePolicy({
      DESKTOP_TARGETS: "portable",
      CONSISTENCY_DESKTOP_RELEASE: "true",
      CONSISTENCY_DESKTOP_PUBLISH: "always",
      CSC_LINK: "certificate",
      GH_TOKEN: "publisher"
    }, "1.2.3")).toThrow(/requires the nsis target/);
    expect(() => releasePolicy.resolveDesktopReleasePolicy({
      DESKTOP_TARGETS: "nsis",
      CONSISTENCY_DESKTOP_RELEASE: "true",
      CONSISTENCY_DESKTOP_UPDATE_CHANNEL: "beta",
      CSC_LINK: "certificate"
    }, "1.2.3")).toThrow(/-beta prerelease tag/);

    expect(releasePolicy.resolveDesktopReleasePolicy({
      DESKTOP_TARGETS: "nsis portable",
      CONSISTENCY_DESKTOP_RELEASE: "true",
      CONSISTENCY_DESKTOP_UPDATE_CHANNEL: "beta",
      CONSISTENCY_DESKTOP_PUBLISH: "always",
      CSC_LINK: "certificate",
      GH_TOKEN: "publisher"
    }, "1.2.3-beta.1")).toEqual({
      requestedTargets: ["nsis", "portable"],
      releaseMode: true,
      releaseChannel: "beta",
      publishMode: "always",
      builderChannel: "beta",
      githubReleaseType: "prerelease",
      updateEligibleArtifact: true
    });
  });
});
