# Notes 03 — ConsistenCy Formal System Model (MATHEMATICAL_MODEL_AUTHOR output, 2026-08-28)

Provenance discipline (binding): 𝓜𝓒 is the *architecture model* abstracted from source-verified facts in notes/01 (cited file:line). Every result proves a property of 𝓜𝓒, NOT of the running implementation, except where a notes/01 code fact raises the claim to implementation level (stated per result). Tags: THEOREM_FROM_KNOWN_MODEL / PROPOSITION_FOR_CONSISTENCY_MODEL / ENGINEERING_INVARIANT / CONJECTURE / PROPOSED_METRIC. Standing assumptions A# reused across sections. No independence assumed without statement.

## 1. System State

Discrete time t ∈ ℕ (event-serialized steps of the host event loop; A2). Global state:
X_t = (R_t, S_t, Q_t, 𝔄_t, C_t, V_t, K_t, E_t, P_t, B_t)

- R_t external repository state (HEAD, object DB, worktree) — HIDDEN except via observation digest (repositorySupervisor.ts:237-239,344-535)
- S_t pinned snapshot set: immutable (repo, sha) pins (snapshot.ts:1-120, fail-closed rev-parse --verify)
- Q_t admission queue: (priority, enqueue-order) (scheduler.ts:225-271)
- 𝔄_t ACB registry: AgentId → 12-state LTS + frozen AgentSnapshot projections (agent/types.ts:140-172, state.ts:27-50); capability attestations are 12-hex descriptor fingerprints, non-authoritative
- C_t capability table: h ↦ {subject, runId, action, resource, scope, expiresAt, revoked, budgetRef} (broker.ts:120-183,195-218) — HIDDEN (256-bit handles never leave kernel; observable projection = audit events + 48-bit fingerprints)
- V_t context visibility: per-agent page table PT_a: PageId → {pinned,hot,cold,evicted} over content store H: text→{0,1}^256 (manager.ts; pinned→evicted forbidden)
- K_t service/fiber availability: coeffect provision + fiber states (adapter.ts:46-130, scheduler-bridge.ts:4-19)
- E_t evidence store: immutable records, content-derived fingerprints (store.ts:43-140,148-163)
- P_t provider state: availability, server-side keys, effective service rate (review/llm/*, llm-facade.ts:73-140) — HIDDEN
- B_t budgets: per-capability (used_c, reserved_c), invariant used+reserved ≤ max (accounting.ts:43-74)

Justification: C_t,B_t inputs to Auth (§2); 𝔄_t,Q_t scheduling dynamics (§5,7); K_t,V_t orthogonality witnesses (§4); E_t evidence (§9); S_t reproducibility (R1); R_t freshness (§10); P_t liveness/queueing caveats. No unused variables. Tag: definitional PROPOSITION_FOR_CONSISTENCY_MODEL.

## 2. Authorization Predicate & Safety S1

Syscall request q = (h, a, α, r, s). Nine checks:
χ1: h ∈ dom(C_t); χ2: ¬revoked; χ3: expiresAt > t; χ4: subject = a.id; χ5: κ(r) ∈ {evidence,workspace} ⇒ runId = a.runId; χ6: action = α; χ7: matchResource per kind (repository by id; snapshot by repositoryId+sha; evidence/workspace by runId; github.publish optional pullNumber pin; llm by provider; ast by snapshotId); χ8: checkScope (scope.sha set ⇒ request sha must equal — omission is scope_violation; scope.paths minimatch globs); χ9: Reserve_Bt (two-phase).

Auth(a,α,r,s,t) ≡ ⋀_{i=1..9} χ_i — ordered first-failure deny chain returning (0, reason_i); total; every decision (allow AND deny) journaled.

Protected set Π (12 registered actions; routing table authorize.ts:46-101): pure/direct {ast.query}; read/direct {repo.read, repo.search, repo.diff, evidence.read, workspace.read, audit.read}; revertible/direct {workspace.write, evidence.write}; commit/direct {llm.invoke}; commit/intent Π_intent = {repo.write, github.publish} → CommitCoordinator, never inline.

S1: □( Exec(α,r,t) ⇒ Auth(q, m(q)) = 1 ), where m(q) = mediation point (serialization step of Auth evaluation inside same gateway.invoke), m(q) ≺_ser t.

Assumptions:
- A1 (complete mediation at the BROKER): every effect in Π reaches kernel via gateway.invoke → broker.authorise. BOUNDARY: gateway passes unregistered actions through (no unknown-syscall reject at gateway — notes/01 GAP); mediation completeness relies on broker χ1/issuance denial (issuance validates CAPABILITY_ISSUABLE_RING, so no record exists for unregistered α). Composite stays default-deny; the broker, not the gateway, is the complete mediator.
- A2 (synchronous serialized mediation): Auth evaluated synchronously inside syscall boundary; invocations totally ordered by host event loop; no revocation write interleaves χ-evaluation and handler invocation (no TOCTOU inside gateway; cf. bishop1996, garfinkel2003).
- A3 (no caching): all 9 checks re-evaluated per invocation.

Derivation: S1 holds by construction — only rule producing Exec is "invoke evaluates Auth; 0 ⇒ throw (handler never called); 1 ⇒ handler" (authorize.ts:46-102; intent-class throws CommitCoordinatorRequiredError BEFORE authorization, zero inline handler calls, coordinator.ts:39-183). Without A1–A3 the rule isn't the only execution producer and S1 vacuous.

Mapping: broker.ts:245-308 ordered checks; :376-411 resource match; :413-443 scope; ReservationToken commit/release; llm usage committed by trusted Ring-1 handler. Doc/code divergence "8 vs 9 checks" — model uses 9. Level: model + code (bypass-absence is an assumption about future code).

Failure conditions: (i) effect path bypassing invoke (A1) — note OS containment NOT ENFORCED beyond child-process; (ii) caching (A3); (iii) check-use gap in non-serialized runtime (A2) — S1 survives under mediation-point semantics but stronger "no execution after t_r" needs A2; (iv) gateway passthrough concentrates completeness burden on broker.

Tags: S1 ENGINEERING_INVARIANT (code-supported w/ A1 boundary); predicate definition PROPOSITION_FOR_CONSISTENCY_MODEL.

## 3. Revocation Dominance (S2)

revoke(h*, t_r): C(h*).revoked ⊥→⊤ (journal+event; permanent; no cascade; propagation deferred). Then ∀ q citing h* with m(q) ⪰_ser t_r: Auth(q, m(q)) = 0, independent of K, V, P, 𝔄, Q.

Assumptions: A1–A3 + A4 (monotone flag: never reset — code-confirmed broker.ts:195-218) + A5 (atomic revocation write w.r.t. mediation evaluations; event-loop serialization).

Proof: Auth = ⋀χ_i ≤ χ2. By A4, ∀t ⪰ t_r: revoked = ⊤ ⇒ χ2 = 0 ⇒ Auth = 0 (reason `revoked`, position 2). Independence is SYNTACTIC: free variables of Auth ⊆ {C_t,B_t,h,a,α,r,s,t}; K,V,P,𝔄,Q do not occur; Auth total in declared inputs. With S1: no execution with mediation point ⪰ t_r. ∎ (Model level; A4/A5 code-supported.)

SCOPE CARVE-OUT (honest): for α ∈ Π_intent, authorization occurs at INTENT ACCEPTANCE (coordinator.ts:39-183): post-acceptance revocation does not erase accepted intents; the effect proceeds under idempotency-key dedupe + downstream lease/backoff/retry (publish/worker.ts: lease 30000ms, timeout 15000ms, max 3 attempts). Accept(key) ⇒ Effect governed by acceptor, not Auth at effect time. S2 is FALSE for this class if read as "no post-revoke irreversible effect from pre-revoke-accepted intents" — S2 scoped to mediation points.

Failure conditions: unmediated path; cached decisions; check-use gap; un-revocation (A4 violation); intent-class carve-out; in-flight ops whose mediation preceded t_r complete (revocation ≠ cancellation of in-flight effects). Tag: PROPOSITION_FOR_CONSISTENCY_MODEL.

## 4. Orthogonality

### 4.1 Available ⊬ Auth, Auth ⊬ Available
Available(a,s,t) ≡ [service s provided in a's isolation context] ∧ [fiber of a ACTIVE] (adapter.ts:46-130; root.isolate). Witness W1 (Auth ∧ ¬Available): valid unrevoked record; ast service never provided ⇒ fiber PENDING; Auth of would-be request = 1; Available = 0. Witness W2 (¬Auth ∧ Available): fiber ACTIVE holding facade; revoked at t_r < t; propagation not yet run; Available = 1, Auth = 0 by S2. Neither entailment valid. SAFETY RESTS ONLY ON AUTH: Exec gated by S1 alone; Available ≡ 0 ⇒ no executions ⇒ S1 vacuous. Availability failures degrade LIVENESS only. Tag: PROPOSITION_FOR_CONSISTENCY_MODEL.

### 4.2 Visible ⊬ Auth; stale-facade window
Visible(a,x,t) ≡ PT_a(x) ∈ {pinned,hot}. Syntactic: V_t not an input to Auth. Witnesses: page present + no capability ("page membership grants no capability", manager.ts); capability with all pages evicted (cold allowed; pinned→evicted throws fail-closed).

Stale-facade window W = [t_revoke, t_unload]; δ_prop = t_unload − t_revoke ≥ 0. PROPOSITION (propagation-timing independence): ∀ δ_prop ∈ [0,∞] (incl. ∞ = disposer never runs): all syscalls through the stale facade during W are DENIED. Proof: mediation point ⪰ t_revoke; apply S2. Bounded eventual consistency required ONLY for resource reclamation (liveness/cleanliness), never security soundness; propagation starvation cannot open an authority window. ∎ Tag: PROPOSITION_FOR_CONSISTENCY_MODEL.

## 5. Agent Lifecycle

ACB LTS 𝒯_ACB = (S_ACB, →_A), 12 states: NEW, READY, RUNNING, WAIT_LLM, WAIT_TOOL, WAIT_IO, WAIT_AGENT, WAIT_HUMAN, SUSPENDED, SUCCEEDED, FAILED, CANCELLED; T_term = {SUCCEEDED,FAILED,CANCELLED} absorbing (state.ts:27-50). OWNERSHIP: scheduler sole registry writer — NEW→READY (register); READY→RUNNING (admit); RUNNING→WAIT_τ (records PendingOperation); WAIT_τ→READY (wake); suspend/resume; →SUCCEEDED/FAILED; →CANCELLED (cancelRun cascade; P1 deadline-expiry cancels expired READY agents in ACTIVE runs — never admits expired). Executor/agent code REQUESTS blocking/wakeups, effects them only via scheduler primitives; gateway owns NO ACB transitions. Run-level: CREATED→ACTIVE→terminal; cancellation cascades; dispatched external work NOT rolled back.

Fiber LTS 𝒯_F: PENDING→LOADING→ACTIVE on facade load; ACTIVE→UNLOADING→PENDING on dispose/cleanup; no service ⇒ PENDING (absorbing while absent); suspension ⇒ fiber cleanup. Cordis 4.0.0-rc.8 library semantics — EXTERNAL AXIOM (limitation; upgrade re-opens proposition).

One-way coupling κ: κ(admit)=activate, κ(suspend)=cleanup, κ(cancel)=dispose; revoke triggers dispose autonomously. Kernel events may DISABLE fiber transitions, never ENABLE activation; no fiber event changes ACB state.

PROPOSITION (well-defined product): κ-restricted asynchronous product 𝒯 = 𝒯_ACB ∥_κ 𝒯_F well-defined (κ partial function between disjoint label sets ⇒ composed relation single-valued). Space ⊆ S_ACB × S_F (48 pairs). Derived invariant (scheduler-bridge.ts:4-19): fiber ACTIVE ⇒ ACB ∈ {RUNNING} ∪ {WAIT_τ}; (WAIT_LLM, ACTIVE) reachable (confirmed); (NEW, ACTIVE), (SUSPENDED, ACTIVE) unreachable. ∎ Tags: LTS definitions ENGINEERING_INVARIANT; product + derived invariant PROPOSITION_FOR_CONSISTENCY_MODEL; model-checking PROPOSED_EXTENSION (clarke1981).

## 6. Workflow DAG

Definition → G=(V,E), |V|≥1, typed against registry R (two types: analyzer.deterministic-evidence [repo.read, evidence.write]; verifier.persisted-evidence [evidence.read]), failurePolicy literal "fail-closed". Four functions: validate (structural well-formedness incl. acyclicity via Kahn; deterministic topo order σ, ties by id); compile (node-type resolution; capabilityRequirements must be registered actions; agentSpecs in σ-order; issues NO durable authorization — requirements are DATA); dryload (feasibility-check-only, same compile functions); execute (fails closed BEFORE any Run record; pins HEAD → RepositorySnapshot.create; run persisted; per-node PER-SYSCALL Auth).

Thm 6.1 (topological order exists): acyclic ⇒ ∃ topo order; Kahn O(V+E). THEOREM_FROM_KNOWN_MODEL. Petri apparatus = negative result (unnecessary until cycles/deferred choice).

Prop 6.2 (validity ⊥ authorization; data-authority noninterference = S3): factor X_t = (D_t, Y_t), D_t = data plane (definitions, plans, bindings, trigger modes, event identities), Y_t ⊇ (C_t,B_t). Verdict functional V:(q,X)↦Auth(q) is invariant under data substitution: ∀D,D': V(q,(D,Y)) = V(q,(D',Y)). Hence no propositional formula φ over data-plane facts entails any nontrivial Auth outcome (except unsat/valid φ). Derivation: free variables of Auth exclude all D-coordinates. Witnesses: (i) valid plan + zero capabilities issued ⇒ all in-run requests denied (χ1); (ii) no plan (manual run) + kernel-issued capability ⇒ allowed. PRECISION: data influences WHICH issuance requests are made (catalog mirrors ReviewWorkload.issueCapabilities); issuance is kernel-side ring-validated (Ring 0 actions unissuable outside kernel) — the request STREAM is data-dependent, no VERDICT on a given request is. Triggers = "pure observability provenance, never an authorization". ∎ Tag: PROPOSITION_FOR_CONSISTENCY_MODEL.

Prop 6.3 (execution soundness & liveness): Soundness — every external effect of a run either (a) mediated syscall with Auth=1 at mediation point, or (b) accepted commit-intent (idempotent, hash-committed, durable-sink persisted). ENGINEERING_INVARIANT (code-confirmed). Liveness — under (F1) G finite acyclic; (F2) node executions terminate (deterministic analyzers total; LLM: one repair attempt then typed StructuredOutputError); (F3) fail-closed node failure ⇒ terminal run status; (F4) fair dispatch (ASPIRATIONAL: single-flight, poll 5s, batch 5, one attempt, no retry; priority interference can starve); (F5) crash-freedom (startup recovery executing→failed — honest failure not progress): run reaches terminal status in σ-order. Tag: PROPOSITION_FOR_CONSISTENCY_MODEL under F1–F5, F4/F5 aspirational.

Honest limitations (from notes/01 GAPS): trigger exactly-once INITIATION (durable dedupe key sha256[domain,repositoryId,definitionId,event.dedupeKey]; fenced UPDATE WHERE status='pending') but at-most-once EXECUTION, no retry; CommitCoordinator dedupe IN-MEMORY — restart without persisted sink loses dedupe memory ⇒ post-restart duplicate acceptance possible; supervisor-side event dedupe in-memory (identity durable only via derived key).

## 7. Queueing Baseline — BASELINE APPROXIMATION

c = maxRunningAgents (wired: 1); λ arrival rate; μ service rate; τ=1/μ; A_e=λ/μ; ρ=λ/(cμ).

(7.1) Stability: λ < cμ (M/M/c positive recurrence). THEOREM (kleinrock1975).
(7.2) Erlang-C: P_wait = [A_e^c/(c!(1−ρ))] / [Σ_{k=0}^{c−1} A_e^k/k! + A_e^c/(c!(1−ρ))]; E[W_q] = P_wait/(cμ−λ); E[W] = W_q+τ. c=1: P_wait=ρ, E[W_q]=ρ/(μ−λ). THEOREM.
(7.3) Little: L = λW, L_q = λW_q — discipline-independent (holds under priority). THEOREM (little1961).
(7.4) Kingman (GI/G/1, c=1 — NOT equality, not c>1): W_q ≈ [ρ/(1−ρ)]·[(c_a²+c_s²)/2]·τ. Exact for M/M/1. Message: near-capacity delay scales with variability. THEOREM (kingman1962, heavy traffic).
(7.5) Priority-then-FIFO = non-preemptive HOL priority (Kleinrock): classes 1>2>…; σ_k=Σ_{i≤k}ρ_i; W_0=Σ_i λ_i E[S_i²]/2; E[W_q^(k)] = W_0/((1−σ_{k−1})(1−σ_k)). STARVATION SHAPE: σ_{k−1}→1 ⇒ E[W_q^(k)]→∞ even when overall ρ<1; low-priority delay blows up as (1−σ_{k−1})^{-1}. THEOREM. Fair-share alternatives (demers1990, parekh1993) NOT implemented.

ASSUMPTIONS TABLE: Poisson arrivals VIOLATED (poll-batched, debounce-flushed, dedupe-thinned; superposition over many repos tends to Poisson but few repos ⇒ grid structure dominates); Exponential service VIOLATED (token-quantized, co-batch-coupled yu2022; server-internal state changes μ invisibly kwon2023; history-dependent zheng2024sglang); FCFS within priority HOLDS (strict tie-break, code-confirmed); Infinite buffer approximation; Stationarity questionable. Tag: BASELINE APPROXIMATION (G/G/c-like with batched arrivals).

## 8. CMDP Research Model — PROPOSED, NOT IMPLEMENTED

CMDP = (𝒮, 𝒜, P, c, {g_k}, γ): 𝒮 = queue composition, remaining budgets, provider availability, running count; 𝒜 = admit/defer/cancel; P = transition kernel (UNKNOWN in practice — would need estimation); c = per-step cost; g_k = resource-k consumption. Objective min_π E[Σγ^t c] s.t. E[Σγ^t g_k] ≤ B_k. Lagrangian L(π,λ) (altman1999); finite-state discounted ⇒ strong duality + optimal stationary randomized policy at saddle point.

MANDATORY HONESTY: (i) current scheduler is NOT an optimizer — deterministic 3-pass feasible heuristic (P1 deadline cancel; P2 capacity guard; P3 priority-FIFO), no value function, no lookahead. (ii) Budgets NOT enforced at admission (scheduler has zero budget references): ACB token/cost/wallTime budgets are policy metadata, unenforced; only enforced budgets are two-phase reserve/commit at AUTHORIZATION (χ9). A faithful constraint must be relocated to the authorization boundary or admission state extended. (iii) costUsdMicros exists end-to-end but LLM facade reports tokens only — cost constraints unconsumable in practice. Tag: CONJECTURE/PROPOSED_EXTENSION (the gap statements are ENGINEERING_INVARIANT of what IS).

## 9. Evidence Model

e = (source, ruleId, loc(path,startLine?,endLine?), conf∈[0,1], payload, prov(repository,sha,analyzer,analyzerVersion)). Store applies deterministic normalization N (path normalization; fingerprints computed by store, never trusting analyzer-supplied; validates; deep-freezes) + label evid_<uuid>. fp(e) = SHA-256(canonical(N(e))); canonical = key-sorted recursive JSON, ARRAY ORDER PRESERVED, depth cap 64, rejects non-plain/cycles; over the 11-tuple. prov.sha load-bearing (different revision ⇒ different identity).

Prop 9.1 (Evidence Grounding): (a) workflow-runtime findings: ∀f ∃E_f ≠ ∅ (schema .min(1)). (b) ground: Finding* → {accept,downgrade,reject}* deterministic classifier: unknown evidence ids ⇒ reject; unchanged-file refs ⇒ reject; out-of-range lines ⇒ reject; confirmed outside hunks or without deterministic signal ⇒ downgrade; accepted get evidence attached deterministically. (c) TWO-LEVEL strictness (honest): review schema (legacy migration) evidenceIds OPTIONAL — findings CAN exist with zero ids; only workflow-runtime enforces ≥1. Findings cannot cite nonexistent evidence (runtime); confirmed claims cannot survive without hunk location + deterministic signal. Tags: (a),(b) ENGINEERING_INVARIANT; schema gap recorded as limitation. Legacy Python risk composer weights NOT derived from kernel evidence — two risk worlds.

Prop 9.2 (Determinism): A_v total deterministic (byte-stable; totality via lone-surrogate→U+FFFD; ordering (path,startLine,endLine,ruleId); engine/__main__.py, protocol.py). Then (x,v)=(x',v') ⇒ fp(N(A_v(x))) = fp(N(A_v(x'))). Proof: A_v deterministic ⇒ equal structured outputs; N, canonical, SHA-256 functions ⇒ equal hashes (composition preserves equality; no probability). Assumptions: A6 analyzer determinism at pinned version (code-confirmed); A7 canonical well-defined — deterministic JSON number rendering (IEEE-754 platform-stable — ENGINEERING assumption); A8 version pinning decidable from record (analyzerVersion in prov).

Prop 9.3 (Collision bound): SHA-256 as RANDOM ORACLE (idealization, explicit). n records, b=256: P[∃i<j: fp_i=fp_j] ≤ C(n,2)·2^{-b} ≤ n²/2^{257}. Union bound over pairs — requires NO independence among collision events, only pairwise bound. n=10^9 ⇒ ≤2^{-197}. fp injective up to negligible model-probability. Tag: THEOREM_FROM_KNOWN_MODEL (union/birthday under RO idealization; merkle1989 lineage, degenerate one-leaf Merkle).

## 10. Freshness (per Lane E verdict)

10.1 REJECTION of linear time-age Δ(t)=t−u(t). DORMANCY COUNTEREXAMPLE: no commits 90 days, analysis pinned at HEAD: Δ=90d while version staleness D=0 and findings perfectly content-fresh. Conversely 50 trivial commits in 1h: Δ≤1h, D=50, findings may reference nonexistent code. Time-age ANTI-CORRELATED with staleness in low-change regime, uninformative in high-rate. REJECTED. (kosta2020 nonlinear instinct right, wrong variable — cost is diff-content.)

10.2 Version Staleness (PROPOSED_METRIC): D(t) = d(analyzedSha(t), HEAD(R_t)), d(s1,s2) = |anc(s2) \ anc(s1)| (commits reachable from HEAD not from analyzed). Caveats: (i) git history is a DAG not monotone counter — diverged histories need convention (adopted ancestor-set difference; merge-base interpretation otherwise); (ii) operative "version" is the DIGEST EQUIVALENCE CLASS [headSha, workflowDigest, normalizedChangedFiles]; D on commits is its linear-history shadow. Version-AoI mapping (buyukates2021): Δ_v(t) = v(t) − v̂(t) — PROPOSED_EXTENSION; gossip machinery N/A.

10.3 Detection latency & peak staleness bound. Setup: poll grid t_k = t0 + k·T_poll; scan δ_scan; debounce T_deb (dwell-time semantics, tabuada2007); run T_run (single attempt). A9: change epochs exogenous; scans don't overlap (δ_scan ≤ T_poll; overlapping dropped); no further digest change after triggering one (no re-arm).
PROP 10.1: change at θ detected by θ+T_poll+δ_scan, flushed by +T_deb, covered by evidence (run terminal) by θ+T_poll+δ_scan+T_deb+T_run. sup_t(time-to-fresh-evidence) ≤ T_poll+δ_scan+T_deb+T_run. Proof: first-observation grid-phase case analysis; digest comparison noise-free (why CUSUM NOT_APPLICABLE — page1954/basseville1993 boundary); debounce flushes exactly T_deb later (A9); run terminal ≤ T_run by Prop 6.3(F1–F3); compose. Failure: A9 violations — re-arm bursts, scan overlap, crashes (single attempt ⇒ unbounded delay). Tag: PROPOSITION_FOR_CONSISTENCY_MODEL.

10.4 Average detection latency (A10: changes Poisson rate λ_c, independent of grid): grid phase uniform ⇒ E[wait-to-next-poll] = T_poll/2. Low-rate regime λ_c·T_deb ≪ 1: E[detection delay] = T_poll/2 + T_deb (shape); renewal-reward (ross1970) long-run average = same at low rate. CAVEAT: general regime needs burst-size distribution; only shape claimed. E[peak version lag] ≤ λ_c(T_poll+δ_scan+T_deb+T_run). Kaul buffer insight (kaul2012): single-run-per-event + dedupe = buffer-size-1 replace-on-new — the one genuine AoI transfer. Tag: PROPOSED_METRIC/derivation.

10.5 Event-triggered vs periodic (CONJECTURE): long-run average cost per cycle = (C_r + ∫g(D(t))dt) via renewal-reward; staleness penalty g NOT ESTABLISHED. Licensed qualitative claim (astrom1999 structure): change-triggered beats cron-triggered at equal worst-case latency and action budget. Quantitative dominance = CONJECTURE pending calibrated g.

## 11. Unified Model — PROPOSED_CONSISTENCY_FORMAL_MODEL (lens, not implemented)

X_{t+1} = F(X_t, u_t, W_t), u_t = π(X_t). Current π = deterministic 3-pass feasible heuristic (NOT optimizer). W_t exogenous (repo changes, provider latency/outage, crashes). HARD CONSTRAINTS (not tradeable): S1, S2 (authorization); budget invariants used+reserved ≤ max (two-phase, at AUTHORIZATION not admission); dependency availability (DAG predecessors terminal); evidence validity (grounding, workflow-runtime level). Objective sketch: min_π E[Σ_t (w_lat·latency + w_stale·g(D(t)) + w_cost·cost + w_risk·risk)] s.t. S1–S3. Risk aggregation axioms open (notes/01 TQ10). NO component computes F, π-beyond-heuristic, or the objective. All four notes/01 divergences carried as stated limitations.

## 12. Formal Properties

| ID | Property | Formal content | Assumptions | Status |
|---|---|---|---|---|
| S1 | No protected syscall without Auth at boundary | □(Exec ⇒ Auth(m(q))=1) | A1–A3; boundary: gateway passthrough relies on broker denial | ENGINEERING_INVARIANT (code-supported; bypass-absence assumed) |
| S2 | Revocation dominates lifecycle propagation | §3; verdict 0 ∀ mediation ⪰ t_r, independent of K_t; intent carve-out | A1–A5 | PROPOSITION (A4/A5 code-supported) |
| S3 | UI/data cannot become authority source | Prop 6.2 noninterference | Data alters C_t,B_t only via kernel ring-validated issuance | PROPOSITION |
| T1 | Git facts from git object DB | Read:(repo,sha,path)→blob pure; fail-closed rev-parse; worktree mutations can't change existing snapshots | Git object DB integrity (out of model) | ENGINEERING_INVARIANT |
| T2 | PR facts from provider API | provider-mediated fail-closed; secrets server-side; redaction; publish only via intents | Provider truthfulness (out of model) | ENGINEERING_INVARIANT (partially code-grounded) |
| E1 | Findings reference persisted evidence | workflow-runtime ∀f∃E_f≠∅; deterministic ground classifier | schema .min(1); GAP: legacy review schema optional | ENGINEERING_INVARIANT (workflow runtime only) |
| R1 | Reproducible evidence fingerprints | Prop 9.2 + 9.3 | A6–A8; RO idealization | PROPOSITION (inputs ENGINEERING_INVARIANT) |
| L1 | Admitted eligible agents eventually progress | under fair dispatch (ASPIRATIONAL: HOL starvation), available deps (else PENDING forever), unexhausted budgets (χ9 conditional), provider availability (no LLM retry), crash-freedom (recovery→failed) | F4/F5 + four listed | PROPOSITION under stated fairness; deadline enforcement is the one ENFORCED liveness-adjacent mechanism (honest failure, not progress) |

## 13. Symbol Table

(as in original; N,t discrete time/event-loop order; X_t state tuple; R_t repo; S_t snapshots; Q_t queue; 𝔄_t ACB registry; C_t capability table; V_t visibility; K_t availability; E_t evidence; P_t provider; B_t budgets; Π/Π_intent protected/intent actions; q request; χ1..χ9 checks; Auth predicate; Exec/m(q)/≺_ser execution+mediation+serialization; S1–S3 safety; t_r/t_unload/δ_prop revocation epochs; W stale-facade window; Available/Visible; S_ACB/→_A/T_term; S_F/→_F; κ/∥_κ coupling+product; G=(V,E)/σ DAG+topo; D_t/Y_t/φ data plane; validate/compile/dryload/execute; e/prov/N/canonical/fp evidence; A_v analyzer; λ,μ,τ,c,ρ,A_e queueing; P_wait/W_q/W/L/L_q; c_a²,c_s²; σ_k/W_0; CMDP tuple; Δ(t)/D(t)/d/Δ_v freshness; T_poll/δ_scan/T_deb/T_run; θ/τ_det/τ_flush/τ_evid; λ_c; F/u_t/W_t unified; A1–A10; ground)
