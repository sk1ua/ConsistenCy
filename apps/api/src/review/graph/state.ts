import { Annotation } from "@langchain/langgraph";
import type {
  AgentRun,
  DomainAnalyzeSuccess,
  DomainComposeReviewSuccess,
  PRReviewContext,
  ReviewFinding,
  ReviewPlan,
  ReviewReport,
  ReviewAccessMode
} from "@consistency/schema";

export const ReviewGraphState = Annotation.Root({
  jobId: Annotation<string>,
  repositoryFullName: Annotation<string>,
  pullRequestNumber: Annotation<number>,
  installationId: Annotation<number | undefined>,
  accessMode: Annotation<ReviewAccessMode>({
    reducer: (left, right) => right,
    default: () => "github_app"
  }),
  baseSha: Annotation<string>,
  headSha: Annotation<string>,
  context: Annotation<PRReviewContext | undefined>,
  deterministicResult: Annotation<DomainAnalyzeSuccess | undefined>,
  composedReview: Annotation<DomainComposeReviewSuccess | undefined>,
  plan: Annotation<ReviewPlan | undefined>,
  agentRuns: Annotation<AgentRun[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  findings: Annotation<ReviewFinding[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  report: Annotation<ReviewReport | undefined>,
  errors: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
});

export type ReviewGraphStateValue = typeof ReviewGraphState.State;
