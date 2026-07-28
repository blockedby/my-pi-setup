---
name: code-review
description: Review code changes for actionable defects using repository context, tests, evidence, impact, and confidence. Use when asked to review a diff, pull request, commit, patch, or changed implementation for correctness.
---

# Code Review

Review the change for real defects. Use the task intent, changed code, surrounding implementation, repository guidance, and existing tests as references. Exercise engineering judgment rather than mechanically enforcing generic preferences.

## Scope

Report only problems introduced or materially worsened by the change. Prefer a small number of well-supported findings over comprehensive commentary.

Do not report:

- style preferences;
- speculative hardening;
- unrelated pre-existing issues;
- impact-1 polish or improvements a reasonable author would decline;
- concerns with confidence below 50.

A pre-existing issue is blocking only when the change materially introduces, worsens, or exposes it in the changed behavior.

## Review process

1. Establish the task intent and review boundary. Inspect the relevant diff, base revision, repository instructions, surrounding call sites, configuration, and tests.
2. Trace changed behavior through concrete inputs and operational paths. Look for violated requirements, regressions, incorrect assumptions, unsafe side effects, and missing compatibility handling.
3. For each candidate, define the concrete scenario and compare expected behavior with actual or inevitable behavior.
4. Try to disprove the candidate. Check existing tests and contracts before escalating it.
5. Gather the cheapest sufficient evidence:
   1. direct static reasoning;
   2. an existing failing test or runtime artifact;
   3. a focused regression or contract test;
   4. a safe local reproducer;
   5. an integration check when cheaper evidence is insufficient.
6. A new test is preferred when it is natural, stable, safe, and protects a useful invariant, but it is not mandatory when the defect is already clear.
7. Do not deploy, perform destructive operations, build expensive images, mutate production, or take similarly risky actions solely to prove a finding. State the bounded verification required instead.

When a candidate has impact 3–4 but confidence below 80, use an available finding-verification skill or a bounded verifier subagent. Ask the verifier to try to disprove the candidate and produce only the minimum sufficient evidence. Do not request another general review.

## Scoring

Score impact and confidence independently.

### Impact

- `4` — security, privacy, data loss, corruption, destructive effects, or systemic outage.
- `3` — violates a stated requirement or breaks an important user or operational path.
- `2` — bounded edge-case failure, recoverable reliability problem, or material maintainability cost.
- `1` — minor quality improvement; omit it.

### Confidence

- `90–100` — directly reproduced or follows inevitably from the code.
- `80–89` — strong, specific evidence with little remaining uncertainty.
- `50–79` — plausible high-impact concern that requires verification.
- Below `50` — omit it.

Confidence measures certainty that the failure is real, not its severity.

## Disposition

- `BLOCK` — impact 3–4 and confidence at least 80.
- `VERIFY` — impact 3–4, confidence 50–79, and verification could change the verdict.
- `FOLLOW_UP` — confirmed impact 2.

## Output

Return only findings worth acting on. For each finding include:

- title;
- affected file and lines;
- scenario;
- expected behavior;
- actual behavior;
- evidence;
- impact;
- confidence;
- disposition;
- minimal next action.

Use precise file paths and the narrowest useful changed-line range. Explain why the cited changed code causes the behavior; do not rely on a bare test failure or vague warning.

If no `BLOCK` or `VERIFY` findings remain, state exactly:

`READY — no sufficiently important, sufficiently supported defects found.`

Do not invent work to make the report look thorough.
