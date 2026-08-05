import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { workflowSpecSchema, type WorkflowSource, type WorkflowSpec, type WorkflowSummary } from "@consistency/schema";
import { findProjectRoot } from "../config/settings";

export const MAX_WORKFLOW_DRAFT_BYTES = 256 * 1024;
export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Read-only view over the shipped workflows plus a local draft layer.
 *
 * Builtin YAML files under `engine/workflow/workflows` are repository content
 * and are never written by this store. Drafts live in `.consistency/workflows`
 * (gitignored) as JSON, which the Python engine's `load_workflow_file` accepts.
 */
export class WorkflowStore {
  private readonly builtinDirectory: string;
  private readonly draftDirectory: string;

  constructor(options: { builtinDirectory?: string; draftDirectory?: string } = {}) {
    const root = findProjectRoot();
    this.builtinDirectory = options.builtinDirectory ?? join(root, "engine", "workflow", "workflows");
    this.draftDirectory = options.draftDirectory ?? join(root, ".consistency", "workflows");
  }

  private builtinPath(name: string): string {
    return join(this.builtinDirectory, `${name}.yml`);
  }

  private draftPath(name: string): string {
    return join(this.draftDirectory, `${name}.json`);
  }

  isBuiltin(name: string): boolean {
    if (!WORKFLOW_NAME_PATTERN.test(name)) return false;
    return existsSync(this.builtinPath(name));
  }

  private parseBuiltin(path: string): WorkflowSpec {
    const document = loadYaml(readFileSync(path, "utf8"));
    return workflowSpecSchema.parse(document);
  }

  private parseDraft(path: string): WorkflowSpec {
    return workflowSpecSchema.parse(readJson(path));
  }

  list(): WorkflowSummary[] {
    const builtinDirectoryExists = existsSync(this.builtinDirectory);
    const draftDirectoryExists = existsSync(this.draftDirectory);
    const summaries: WorkflowSummary[] = [];

    if (builtinDirectoryExists) {
      for (const file of readdirSync(this.builtinDirectory)) {
        if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
        const spec = this.parseBuiltin(join(this.builtinDirectory, file));
        summaries.push(summaryFor(spec, "builtin"));
      }
    }
    if (draftDirectoryExists) {
      for (const file of readdirSync(this.draftDirectory)) {
        if (!file.endsWith(".json")) continue;
        const spec = this.parseDraft(join(this.draftDirectory, file));
        summaries.push(summaryFor(spec, "draft"));
      }
    }

    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): { spec: WorkflowSpec; source: WorkflowSource } | undefined {
    if (!WORKFLOW_NAME_PATTERN.test(name)) return undefined;
    const draft = this.draftPath(name);
    if (existsSync(draft)) {
      return { spec: this.parseDraft(draft), source: "draft" };
    }
    const builtin = this.builtinPath(name);
    if (existsSync(builtin)) {
      return { spec: this.parseBuiltin(builtin), source: "builtin" };
    }
    return undefined;
  }

  saveDraft(spec: WorkflowSpec): void {
    if (!WORKFLOW_NAME_PATTERN.test(spec.name)) {
      throw new Error(`Workflow name must match ${WORKFLOW_NAME_PATTERN}`);
    }
    const serialized = JSON.stringify(spec, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_WORKFLOW_DRAFT_BYTES) {
      throw new Error(`Workflow draft exceeds the ${MAX_WORKFLOW_DRAFT_BYTES} byte limit`);
    }
    mkdirSync(this.draftDirectory, { recursive: true });
    writeFileSync(this.draftPath(spec.name), serialized, "utf8");
  }

  deleteDraft(name: string): boolean {
    if (!WORKFLOW_NAME_PATTERN.test(name)) return false;
    const draft = this.draftPath(name);
    if (!existsSync(draft)) return false;
    rmSync(draft);
    return true;
  }
}

function summaryFor(spec: WorkflowSpec, source: WorkflowSource): WorkflowSummary {
  return {
    name: spec.name,
    description: spec.description,
    source,
    nodeCount: spec.nodes.length,
    verifierCount: spec.verifiers.length
  };
}
