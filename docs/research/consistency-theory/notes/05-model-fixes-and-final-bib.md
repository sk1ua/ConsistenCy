# Notes 05 — Binding Fix Decisions + Final Bibliography Selection (parent, 2026-08-28)

## Model fixes incorporated into the report (all FATAL+MAJOR + minors from notes/04)

1. F1 FIX: §10 freshness — drop "E[peak version lag]"; state E[D(t)] ≤ λ_c·W at FIXED t, exact under A9; under A10 present as low-rate approximation E[D(t)] ≤ λ_c(W + E[re-arm spread]) with explicit λ_c(T_poll+T_deb)≪1 conditioning; peak only over stated finite horizon H; disclose the trailing-window inclusion step and where re-arm chains break it; state the A9⊂deterministic vs A10⊂Poisson tension explicitly.
2. M1 FIX: Prop 9.3 conditioned on pairwise-distinct canonical encodings (duplicates = dedupe, not collision); new A7′: injectivity of canonicalization as ENGINEERING assumption with depth-cap-64 and number-rendering caveats.
3. M2 FIX: Prop 6.2 renamed "verdict-plane independence (单步、固定状态)"; φ-entailment scoped to same-instant evaluation; explicit sentence: not unwinding-style noninterference over traces; the declared data→authority channel is kernel-side ring-validated issuance. S3 restated accordingly (verdict-plane, one-step).
4. M3 FIX: average detection/flush delay stated flush-referenced: E = T_poll/2 + δ_scan + T_deb (declared), detection-referenced T_poll/2 + δ_scan.
5. Notation (binding for report): cumulative utilization R_k (not σ_k); stale-facade window W_stale; unified-model noise ζ_t; scheduler→fiber coupling φ; verdict functional 𝒱; data plane 𝒟_t; unified map Φ; drop ghost τ_det/τ_flush/τ_evid; add π to symbol table; WAIT_τ subscript retained.
6. Queueing assumptions table gains row: RUNNING→WAIT_τ may release the running slot during an outstanding LLM call ⇒ overlapping service breaks one-job-in-service abstraction during LLM waits.
7. CMDP: add Slater-type strict feasibility + finite action set to the duality sentence.
8. S2: symmetry sentence — acceptance-time freezing likewise applies to χ3 expiry and budget reservation for accepted intents.
9. A2 scoped to the kernel's mediation loop (execution domains exist: worker-thread/child-process).
10. d(s1,s2) disclosed as asymmetric quasimetric failing triangle inequality; orphaned-branch analysis mode noted (D small ⇏ analysis ⊆ HEAD ancestors).
11. Per-item queueing tags: "theorem of the M/M/c (resp. GI/G/1) idealization".
12. S1 tag: "(code-supported invoke path; bypass-absence is an assumption — a universal negative over all code paths)".
13. Prop 6.3 F2: provider hang folded into P_t availability assumption.
14. A2 first-use ordering fixed.

## FINAL BIBLIOGRAPHY (45 entries, hard cap per owner guidance 25–45; all verified in notes/02)

SECURITY (11): dennis1966, anderson1972, saltzer1975, redell1974, hardy1988, miller2003, miller2006, klein2009, watson2010, bishop1996, debenedetti2025
SCHEDULING (8): little1961, kendall1953, kingman1962, kleinrock1975, demers1990, altman1999, yu2022orca, kwon2023vllm
PROVENANCE (7): buneman2001, provdm2013, merkle1989, schneier1999, crosby2009, torresarias2019, gao2023rarr
AGENT/WORKFLOW (12): agha1986, armstrong2003, keller1976, pnueli1977, harel1985, clarke1981, vanderaalst1998, li2022codereviewer, goldman2025, yao2023react, wu2024autogen, hong2024metagpt
FRESHNESS (7): kaul2012, yates2021, astrom1999, tabuada2007, page1954, ross1970, buyukates2021

LOAD-BEARING CORE (20): dennis1966, anderson1972, saltzer1975, redell1974, hardy1988, miller2006, klein2009, little1961, kingman1962, kleinrock1975, altman1999, buneman2001, provdm2013, merkle1989, armstrong2003, keller1976, pnueli1977, kaul2012, yates2021, buyukates2021.

Verified-but-NOT-cited (must NOT be name-dropped in prose where a citation would be expected; recorded in notes/02 for future use): woodruff2014 CHERI, garfinkel2003, shi2025 Progent, garciamolina1987 Sagas, simmhan2005, locke1986, parekh1993, cheney2009, murata1989, dennis1974, hewitt1973, queille1982, vanderaalst2003, laurie2014 CT, slsa, alce, sun2020, kosta2020, sglang, zhou-survey, FlexGen, Reflexion, Toolformer, Self-Consistency, agent surveys, basseville1993, Liu Findings'23, VisTrails, Fowler. (basseville1993 demoted: CUSUM boundary cited via page1954 alone.)
