/**
 * H22 — plugin manifest: identity, integrity, compatibility, declared
 * capabilities, and the trust tier the HOST assigns.
 *
 * Design constraints:
 *   - The manifest is untrusted INPUT. Trust is never read from it: the host
 *     passes the tier it decided (builtin vs third-party), so a third-party
 *     manifest can never promote itself by declaring `trust: "trusted"`.
 *   - `entry` must stay inside the plugin root. Containment is checked on the
 *     REAL path, so a symlink cannot widen it.
 *   - Declared capabilities are checked against the Kernel's own syscall
 *     allowlist, so a plugin cannot declare `github.publish` or invent an
 *     action the Kernel does not mediate.
 *   - Every failure is a coded, human-readable reason. Nothing degrades
 *     silently and nothing is installed on a failed check.
 *
 * The returned `InstalledPlugin.descriptor` is a Kernel `PluginDescriptor`,
 * ready for the existing child-process RPC path (`SandboxManager.launch`).
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { SYSCALL_DEFINITIONS, type PluginDescriptor, type PrivilegeRing } from "@consistency/kernel";
import { isUsableRange, parseSemver, satisfiesRange } from "./version.js";

/** Protocol version this host speaks with sandboxed plugins. */
export const PLUGIN_PROTOCOL_VERSION = "1.0.0";

export type PluginTrustTier = "builtin" | "third-party";

export interface PluginCompatibility {
  /** Host version range (semver). */
  readonly host: string;
  /** Sandbox RPC protocol version range (semver). */
  readonly protocol: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  /** `sha256-<hex>` over the entry file bytes. */
  readonly integrity: string;
  readonly executionDomain: "child-process";
  readonly compatibility: PluginCompatibility;
  /** Action names the plugin declares it needs; grants remain per-method. */
  readonly capabilities: readonly string[];
  /** Plugin id → accepted version range. */
  readonly dependencies: Readonly<Record<string, string>>;
  readonly logicalRing: number;
  readonly title: string;
  readonly summary?: string;
}

export type PluginManifestErrorCode =
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_ENTRY_ESCAPES_ROOT"
  | "PLUGIN_ENTRY_MISSING"
  | "PLUGIN_INTEGRITY_MISMATCH"
  | "PLUGIN_INCOMPATIBLE_HOST"
  | "PLUGIN_INCOMPATIBLE_PROTOCOL"
  | "PLUGIN_DEPENDENCY_MISSING"
  | "PLUGIN_DEPENDENCY_INCOMPATIBLE"
  | "PLUGIN_ID_SHADOWED";

/** Coded, explainable manifest failure — never a silent skip. */
export class PluginManifestError extends Error {
  constructor(
    readonly code: PluginManifestErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "PluginManifestError";
  }

  /** Single-line operator-facing reason: `CODE: message`. */
  get reason(): string {
    return `${this.code}: ${this.message}`;
  }
}

export interface InstalledPlugin {
  readonly id: string;
  readonly version: string;
  readonly trust: PluginTrustTier;
  /** Manifest-relative entry path (as declared). */
  readonly entry: string;
  /** Absolute, containment-checked entry path. */
  readonly entrypoint: string;
  readonly integrity: string;
  readonly executionDomain: "child-process";
  readonly logicalRing: PrivilegeRing;
  readonly compatibility: PluginCompatibility;
  readonly capabilities: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly title: string;
  readonly summary?: string;
  readonly installedAt: string;
  /** Kernel-ready descriptor for the existing child-process RPC path. */
  readonly descriptor: PluginDescriptor;
}

export interface LoadPluginManifestOptions {
  /** Directory the plugin's entry must stay inside. */
  readonly root: string;
  /** Running host version, e.g. "0.1.0". */
  readonly hostVersion: string;
  /** Running protocol version; defaults to PLUGIN_PROTOCOL_VERSION. */
  readonly protocolVersion?: string;
  /** Tier decided by the HOST — never by the manifest. */
  readonly trust: PluginTrustTier;
  /** Ids owned by the trusted codebase (cannot be taken over). */
  readonly builtinIds?: readonly string[];
  /** Already-installed plugins, for dependency resolution. */
  readonly installed?: readonly InstalledPlugin[];
  /** Clock injection for deterministic tests. */
  readonly now?: () => string;
  /** Integrity checks are mandatory: there is no opt-out. */
}

const MANIFEST_KEYS = new Set([
  "id", "version", "entry", "integrity", "executionDomain", "compatibility",
  "capabilities", "dependencies", "logicalRing", "title", "summary"
]);

/** Keys a manifest must never carry: the child env is host-owned (H22 negative). */
const FORBIDDEN_MANIFEST_KEYS = new Set(["env", "envVars", "environment", "trust", "main", "install", "postinstall"]);

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

/** Actions the Kernel treats as commit intents can never be plugin-declared. */
const INTENT_ACTIONS: ReadonlySet<string> = new Set(
  SYSCALL_DEFINITIONS.filter(definition => definition.dispatch === "intent").map(definition => definition.action)
);

const MEDIATED_ACTIONS: ReadonlySet<string> = new Set(SYSCALL_DEFINITIONS.map(definition => definition.action));

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): PluginManifestError {
  return new PluginManifestError("PLUGIN_MANIFEST_INVALID", message, details);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`'${field}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`'${field}' must be a non-empty string`);
  }
  return value.trim();
}

/** `sha256-<hex>` over the entry bytes — the integrity value a manifest must pin. */
export function entryIntegrity(bytes: Buffer | string): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Resolve the entry inside the plugin root and fail closed on escape
 * (absolute paths, `..` traversal, symlinks pointing out of the root).
 */
export function resolvePluginEntry(root: string, entry: string): string {
  if (isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry)) {
    throw new PluginManifestError("PLUGIN_ENTRY_ESCAPES_ROOT", `entry '${entry}' must be relative to the plugin root`, { entry });
  }
  const realRoot = realpathSync(root);
  const lexical = resolve(realRoot, entry);
  const lexicalRelative = relative(realRoot, lexical);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new PluginManifestError("PLUGIN_ENTRY_ESCAPES_ROOT", `entry '${entry}' resolves outside the plugin root`, { entry });
  }
  let stats;
  try {
    stats = lstatSync(lexical);
  } catch {
    throw new PluginManifestError("PLUGIN_ENTRY_MISSING", `entry '${entry}' does not exist in the plugin root`, { entry });
  }
  if (!stats.isFile()) {
    throw new PluginManifestError("PLUGIN_ENTRY_MISSING", `entry '${entry}' is not a regular file`, { entry });
  }
  // Symlinks resolve on the REAL path; a link out of the root is an escape.
  const real = realpathSync(lexical);
  const realRelative = relative(realRoot, real);
  if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
    throw new PluginManifestError("PLUGIN_ENTRY_ESCAPES_ROOT", `entry '${entry}' resolves outside the plugin root through a link`, { entry });
  }
  return real;
}

/**
 * Validate one untrusted manifest and return the installed, host-trusted form.
 * Throws {@link PluginManifestError} with a code plus human-readable reason for
 * every rejection: missing dependency, incompatibility, tampered bytes, entry
 * escape, id shadowing, or a malformed/forbidden field.
 */
export function loadPluginManifest(raw: unknown, options: LoadPluginManifestOptions): InstalledPlugin {
  if (options.trust !== "builtin" && options.trust !== "third-party") {
    throw invalid("the host must pass a trust tier");
  }
  const source = asRecord(raw, "manifest");

  const unknownKeys = Object.keys(source).filter(key => !MANIFEST_KEYS.has(key));
  if (unknownKeys.length > 0) {
    const forbidden = unknownKeys.filter(key => FORBIDDEN_MANIFEST_KEYS.has(key));
    throw invalid(
      forbidden.length > 0
        ? `manifest field(s) ${forbidden.join(", ")} are host-owned and not accepted from a plugin`
        : `unknown manifest field(s): ${unknownKeys.join(", ")}`,
      { unknownKeys, forbidden }
    );
  }

  const id = requiredString(source, "id");
  if (!ID_PATTERN.test(id)) throw invalid(`'id' must match ${ID_PATTERN.source}`);
  const version = requiredString(source, "version");
  if (parseSemver(version) === undefined) throw invalid(`'version' must be semver, received '${version}'`);

  if (options.trust === "third-party" && (options.builtinIds ?? []).includes(id)) {
    throw new PluginManifestError(
      "PLUGIN_ID_SHADOWED",
      `plugin id '${id}' belongs to a trusted builtin and cannot be installed by a third party`,
      { id }
    );
  }

  const entry = requiredString(source, "entry");
  const entrypoint = resolvePluginEntry(options.root, entry);

  const integrity = requiredString(source, "integrity");
  if (!INTEGRITY_PATTERN.test(integrity)) throw invalid(`'integrity' must be 'sha256-<64 hex>', received '${integrity}'`);
  const actualIntegrity = entryIntegrity(readFileSync(entrypoint));
  if (actualIntegrity !== integrity) {
    throw new PluginManifestError(
      "PLUGIN_INTEGRITY_MISMATCH",
      `entry '${entry}' integrity mismatch: manifest declares ${integrity}, file is ${actualIntegrity}`,
      { expected: integrity, actual: actualIntegrity }
    );
  }

  const executionDomain = requiredString(source, "executionDomain");
  if (executionDomain !== "child-process") {
    throw invalid(`'executionDomain' must be 'child-process', received '${executionDomain}'`);
  }

  const compatibilitySource = asRecord(source["compatibility"], "compatibility");
  const hostRange = requiredString(compatibilitySource, "host");
  const protocolRange = requiredString(compatibilitySource, "protocol");
  for (const [field, range] of [["host", hostRange], ["protocol", protocolRange]] as const) {
    if (!isUsableRange(range)) throw invalid(`'compatibility.${field}' is not a usable semver range: '${range}'`);
  }
  const hostVersion = options.hostVersion;
  if (parseSemver(hostVersion) === undefined) throw invalid(`host version '${hostVersion}' is not semver`);
  if (!satisfiesRange(hostVersion, hostRange)) {
    throw new PluginManifestError(
      "PLUGIN_INCOMPATIBLE_HOST",
      `plugin '${id}' requires host ${hostRange}, this host is ${hostVersion}`,
      { id, required: hostRange, host: hostVersion }
    );
  }
  const protocolVersion = options.protocolVersion ?? PLUGIN_PROTOCOL_VERSION;
  if (!satisfiesRange(protocolVersion, protocolRange)) {
    throw new PluginManifestError(
      "PLUGIN_INCOMPATIBLE_PROTOCOL",
      `plugin '${id}' requires sandbox protocol ${protocolRange}, this host speaks ${protocolVersion}`,
      { id, required: protocolRange, protocol: protocolVersion }
    );
  }

  const declared = source["capabilities"];
  if (!Array.isArray(declared)) throw invalid("'capabilities' must be an array of action names");
  const capabilities: string[] = [];
  for (const value of declared) {
    if (typeof value !== "string" || !ACTION_PATTERN.test(value)) {
      throw invalid(`capability '${String(value)}' is not a valid action name`);
    }
    if (INTENT_ACTIONS.has(value) || !MEDIATED_ACTIONS.has(value)) {
      throw invalid(`capability '${value}' is not a Kernel-mediated action a plugin may declare`, { action: value });
    }
    if (!capabilities.includes(value)) capabilities.push(value);
  }

  const dependenciesSource = source["dependencies"] === undefined ? {} : asRecord(source["dependencies"], "dependencies");
  const dependencies: Record<string, string> = {};
  for (const [dependencyId, range] of Object.entries(dependenciesSource)) {
    if (typeof range !== "string" || !isUsableRange(range)) {
      throw invalid(`dependency '${dependencyId}' must map to a usable semver range`);
    }
    const installed = (options.installed ?? []).find(candidate => candidate.id === dependencyId);
    if (!installed) {
      throw new PluginManifestError(
        "PLUGIN_DEPENDENCY_MISSING",
        `plugin '${id}' requires '${dependencyId}' ${range}, which is not installed`,
        { id, dependency: dependencyId, required: range }
      );
    }
    if (!satisfiesRange(installed.version, range)) {
      throw new PluginManifestError(
        "PLUGIN_DEPENDENCY_INCOMPATIBLE",
        `plugin '${id}' requires '${dependencyId}' ${range}, installed version is ${installed.version}`,
        { id, dependency: dependencyId, required: range, installed: installed.version }
      );
    }
    dependencies[dependencyId] = range;
  }

  const logicalRing = source["logicalRing"] === undefined ? 3 : Number(source["logicalRing"]);
  if (!Number.isInteger(logicalRing) || logicalRing < 0 || logicalRing > 3) {
    throw invalid("'logicalRing' must be an integer in [0, 3]");
  }

  const title = source["title"] === undefined ? id : requiredString(source, "title");
  const summary = source["summary"] === undefined ? undefined : requiredString(source, "summary");
  const installedAt = (options.now ?? (() => new Date().toISOString()))();

  const descriptor: PluginDescriptor = {
    id,
    version,
    trust: options.trust === "builtin" ? "trusted" : "untrusted",
    logicalRing: logicalRing as PrivilegeRing,
    executionDomain: "child-process",
    entrypoint,
    requestedOperations: [...capabilities]
  };

  return Object.freeze({
    id,
    version,
    trust: options.trust,
    entry,
    entrypoint,
    integrity,
    executionDomain: "child-process" as const,
    logicalRing: logicalRing as PrivilegeRing,
    compatibility: Object.freeze({ host: hostRange, protocol: protocolRange }),
    capabilities: Object.freeze(capabilities),
    dependencies: Object.freeze(dependencies),
    title,
    ...(summary === undefined ? {} : { summary }),
    installedAt,
    descriptor: Object.freeze(descriptor)
  });
}
