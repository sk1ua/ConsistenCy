import { z } from "zod";
import { severitySchema } from "./review";

const nonEmpty = z.string().trim().min(1);
const nonNegativeInt = z.number().int().nonnegative();
const positiveLine = z.number().int().positive();

/**
 * Step ids double as artifact keys and log labels, so they are constrained to
 * a filesystem- and JSON-pointer-safe shape.
 */
export const stepIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]*$/, "Step id must start with a letter and use only [a-z0-9_-]");

export const sha256DigestSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256 digest");

/**
 * Allowlisted analyzers. A workflow file selects from this set; it cannot
 * supply an arbitrary command. This mirrors the deterministic analyzer registry
 * in `engine/analyzers/registry.py` — adding a capability is a reviewed code
 * change, not a YAML edit, because workflow files are themselves repository
 * content that an attacker may control.
 *
 * The `engine.*` ids map 1:1 onto the existing Python analyzer registry.
 */
export const analyzerKindSchema = z.enum([
  "engine.style",
  "engine.structural",
  "engine.semantic",
  "engine.duplication",
  "engine.security",
  "tool.semgrep",
  "tool.ruff",
  "tool.eslint",
  "graph.dependency",
  "graph.schema_drift"
]);

export const verifierKindSchema = z.enum([
  "verify.unit_tests",
  "verify.build",
  "verify.syntax",
  "verify.llm_sanity"
]);

export const stepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "timed_out"
]);

export const workflowEvidenceItemSchema = z.object({
  file: nonEmpty,
  startLine: positiveLine.optional(),
  endLine: positiveLine.optional(),
  excerpt: z.string(),
  rule: nonEmpty.optional(),
  severity: severitySchema.optional(),
  metadata: z.record(z.unknown()).default({})
}).strict().superRefine((item, context) => {
  const hasStart = item.startLine !== undefined;
  const hasEnd = item.endLine !== undefined;
  if (hasStart !== hasEnd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startLine and endLine must be provided together",
      path: hasStart ? ["endLine"] : ["startLine"]
    });
  }
  if (item.startLine !== undefined && item.endLine !== undefined && item.endLine < item.startLine) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endLine must be greater than or equal to startLine",
      path: ["endLine"]
    });
  }
});

/**
 * Typed payload a step passes downstream. Named to avoid colliding with the
 * retrieval subsystem's `evidencePackSchema` in `./report`, which is a
 * different, snake_case, Python-facing structure.
 */
export const workflowEvidenceSchema = z.object({
  producedBy: stepIdSchema,
  items: z.array(workflowEvidenceItemSchema).default([]),
  summary: z.string().default("")
}).strict();

/**
 * Immutable record of one executed step. `command` is argv, never a shell
 * string, so it can be handed straight to `spawn(..., { shell: false })`.
 */
export const synthesizerKindSchema = z.literal("synthesize.review_report");

/** Every kind that can appear as an executed step, synthesizer included. */
export const stepKindSchema = z.union([
  analyzerKindSchema,
  verifierKindSchema,
  synthesizerKindSchema
]);

export const stepExecutionArtifactSchema = z.object({
  stepId: stepIdSchema,
  uses: stepKindSchema,
  status: stepStatusSchema,
  command: z.array(z.string()).default([]),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  durationMs: nonNegativeInt.optional(),
  rawOutput: z.string().default(""),
  /** Digest over the exact file contents analyzed, for replay and caching. */
  inputDigest: sha256DigestSchema,
  evidence: workflowEvidenceSchema.optional(),
  error: nonEmpty.optional()
}).strict();

const stepBase = {
  id: stepIdSchema,
  needs: z.array(stepIdSchema).default([]),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  continueOnError: z.boolean().default(false),
  with: z.record(z.unknown()).default({})
};

export const workflowNodeSchema = z.object({
  ...stepBase,
  uses: analyzerKindSchema
}).strict();

export const workflowVerifierSchema = z.object({
  ...stepBase,
  uses: verifierKindSchema
}).strict();

export const workflowSynthesizerSchema = z.object({
  id: stepIdSchema.default("synthesizer"),
  needs: z.array(stepIdSchema).default([]),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  with: z.record(z.unknown()).default({}),
  uses: synthesizerKindSchema.default("synthesize.review_report")
}).strict();

const workflowSpecObjectSchema = z.object({
  version: z.literal(2),
  name: nonEmpty,
  description: nonEmpty.optional(),
  nodes: z.array(workflowNodeSchema).min(1),
  verifiers: z.array(workflowVerifierSchema).default([]),
  synthesizer: workflowSynthesizerSchema
}).strict();

type WorkflowSpecShape = z.infer<typeof workflowSpecObjectSchema>;

export type WorkflowGraphIssue = {
  message: string;
  path: (string | number)[];
};

/**
 * Structural validation the object schema cannot express: unique step ids,
 * resolvable `needs` references, and acyclicity.
 */
export function collectWorkflowGraphIssues(spec: WorkflowSpecShape): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const steps: { id: string; needs: string[]; path: (string | number)[] }[] = [];

  spec.nodes.forEach((node, index) => {
    steps.push({ id: node.id, needs: node.needs, path: ["nodes", index] });
  });
  spec.verifiers.forEach((verifier, index) => {
    steps.push({ id: verifier.id, needs: verifier.needs, path: ["verifiers", index] });
  });
  steps.push({ id: spec.synthesizer.id, needs: spec.synthesizer.needs, path: ["synthesizer"] });

  const known = new Set<string>();
  for (const step of steps) {
    if (known.has(step.id)) {
      issues.push({ message: `Duplicate step id '${step.id}'`, path: [...step.path, "id"] });
    }
    known.add(step.id);
  }

  for (const step of steps) {
    step.needs.forEach((need, needIndex) => {
      if (need === step.id) {
        issues.push({
          message: `Step '${step.id}' cannot depend on itself`,
          path: [...step.path, "needs", needIndex]
        });
      } else if (!known.has(need)) {
        issues.push({
          message: `Step '${step.id}' depends on unknown step '${need}'`,
          path: [...step.path, "needs", needIndex]
        });
      }
    });
  }

  // Duplicate or dangling ids make the edge set ambiguous, so only run the
  // topological check once the graph is known to be well-formed.
  if (issues.length > 0) return issues;

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) indegree.set(step.id, 0);
  for (const step of steps) {
    for (const need of step.needs) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      dependents.set(need, [...(dependents.get(need) ?? []), step.id]);
    }
  }

  const queue = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  let resolved = 0;
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    resolved += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (resolved < steps.length) {
    const cyclic = steps
      .filter((step) => (indegree.get(step.id) ?? 0) > 0)
      .map((step) => step.id);
    issues.push({
      message: `Workflow graph contains a cycle involving: ${cyclic.join(", ")}`,
      path: ["nodes"]
    });
  }

  return issues;
}

export const workflowSpecSchema = workflowSpecObjectSchema.superRefine((spec, context) => {
  for (const issue of collectWorkflowGraphIssues(spec)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: issue.path
    });
  }
});

export const workflowRunSchema = z.object({
  runId: nonEmpty,
  specName: nonEmpty,
  status: stepStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  artifacts: z.array(stepExecutionArtifactSchema).default([]),
  error: nonEmpty.optional()
}).strict();

export type StepId = z.infer<typeof stepIdSchema>;
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;
export type AnalyzerKind = z.infer<typeof analyzerKindSchema>;
export type VerifierKind = z.infer<typeof verifierKindSchema>;
export type SynthesizerKind = z.infer<typeof synthesizerKindSchema>;
export type StepKind = z.infer<typeof stepKindSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type WorkflowEvidenceItem = z.infer<typeof workflowEvidenceItemSchema>;
export type WorkflowEvidence = z.infer<typeof workflowEvidenceSchema>;
export type StepExecutionArtifact = z.infer<typeof stepExecutionArtifactSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowVerifier = z.infer<typeof workflowVerifierSchema>;
export type WorkflowSynthesizer = z.infer<typeof workflowSynthesizerSchema>;
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
