/**
 * Deterministic evidence runner — PR-4 analyzers over the SHA-pinned
 * snapshot content, feeding the Kernel EvidenceStore.
 */

import type { EvidenceInput } from "@consistency/kernel";
import {
  SecretAnalyzer,
  StyleAnalyzer,
  TreeSitterService,
  detectLanguage,
} from "@consistency/plugins-builtin";

export interface EvidenceRunnerFiles {
  readonly path: string;
  readonly content: string;
}

export class DeterministicEvidenceRunner {
  readonly #treeSitter = new TreeSitterService();
  readonly #style = new StyleAnalyzer();
  readonly #secret = new SecretAnalyzer();

  /** Run the PR-4 analyzers over the given snapshot-backed files. */
  async run(input: {
    readonly repository: string;
    readonly headSha: string;
    readonly files: readonly EvidenceRunnerFiles[];
    readonly analyzers?: readonly ("style" | "secret")[];
  }): Promise<EvidenceInput[]> {
    const supported = input.files.filter((file) => detectLanguage(file.path) !== undefined);
    const allFiles = input.files;

    const deps = {
      readFile: async (path: string) => {
        const file = allFiles.find((f) => f.path === path);
        if (!file) throw new Error(`missing content for ${path}`);
        return { path: file.path, content: file.content };
      },
      treeSitter: this.#treeSitter,
    };

    const selected = new Set(input.analyzers ?? ["style", "secret"]);
    const styleEvidence = selected.has("style")
      ? await this.#style.analyze(
          { repository: input.repository, headSha: input.headSha, files: supported.map((f) => f.path).sort() },
          deps,
        )
      : [];
    const secretEvidence = selected.has("secret")
      ? await this.#secret.analyze(
          { repository: input.repository, headSha: input.headSha, files: allFiles.map((f) => f.path).sort() },
          deps,
        )
      : [];

    return [...styleEvidence, ...secretEvidence];
  }
}
