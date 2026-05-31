# Annotation Guideline

Use this guideline when labeling PR review risk for the human-aligned evaluation.

## Overall Risk

- `low`: routine change; unlikely to need special reviewer attention beyond normal review.
- `medium`: meaningful drift, higher churn, or local design uncertainty; should receive focused review.
- `high`: security concern, risky semantic change, high-churn hotspot, or change that could block merge without further review.

## Top Risky Files

List the files a human reviewer should inspect first. Prefer 1 to 5 files. If a PR is low risk, still list the file that most deserves a quick look.

## Reason Labels

Use one or more labels:

- `structural`: dependency surface, inheritance, coupling, function/class layout, or complexity structure.
- `semantic`: changed behavior, control flow, API use, data handling, or meaning of abstractions.
- `security`: secrets, injection risks, unsafe deserialization, dangerous dynamic execution, or auth/data exposure.
- `evolution/churn`: unusually large churn, hotspot file, repeated edits, or ownership concentration.
- `duplication`: copy-paste or template-like code likely to increase maintenance burden.
- `unclear`: risk exists but the reason is not obvious from the diff alone.

## Annotation Rules

- Judge risk relative to the repository and PR context, not only generic style.
- Do not mark generated or vendored files high risk unless they affect executable behavior or security.
- For large renames, distinguish file movement from semantic change.
- Write a short rationale that another reviewer could audit later.
- If two annotators disagree, preserve both labels before adjudication.
