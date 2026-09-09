# Sutros trust and feedback implementation plan

> For agentic workers: Use the test-first implementation and review process. The user explicitly requested parallel work with Claude. Independent workers use separate worktrees and file ownership; dependent integration remains sequential.

**Goal:** Make findings inspectable, preserve anonymous submitter privacy, learn from reviewed feedback, correct the mobile render result, and explain technical terms.

**Architecture:** Keep original observations immutable and attach review outcomes separately. Use existing Express routers and PostgreSQL storage, with a versioned evaluation export and a separate glossary UI. Integrate isolated changes into one branch after focused tests and reviews.

**Tech stack:** Existing Node ESM, Express, PostgreSQL, Playwright, vanilla HTML/CSS/JS, Node's built-in test runner.

**Spec:** ../specs/2026-09-09-trust-and-feedback-design.md

## Global constraints

- Preserve the light jade/gold SUTROS design and plain language.
- No secret values in output, fixtures, commits, or public responses.
- Preserve network safety guards and read-only target behavior.
- Never turn votes into ground truth or train/change production prompts automatically.
- Preserve version 1 report verification while adding version 2.
- No changes to the original main checkout or production during implementation.
- Tests must exercise behavior, using real components and controlled I/O boundaries.

## Task 1: Anonymous privacy and data minimization

Own the privacy files listed in the spec and tests/privacy*.test.js, tests/ratelimit*.test.js, tests/http-body*.test.js. Work in ../sutros-privacy.

- [ ] Write failing tests showing that publicReport removes userId/account identity while retaining evidence and coverage, that public views still expose only server-derived ownership capabilities, and that malformed/sensitive entry URLs cannot publish credentials.
- [ ] Reproduce the 24-hour limiter losing its events after hourly cleanup; write an explicit-clock boundary test.
- [ ] Reproduce the HTTP reader consuming past its requested limit; use a controlled ReadableStream and assert bounded consumption/cancellation.
- [ ] Run `node --test tests/privacy*.test.js tests/ratelimit*.test.js tests/http-body*.test.js` and capture expected failures.
- [ ] Implement the specified projection and wire every public route/SSE boundary. Preserve private storage. Allow null reports.score for unrated results. Implement the targeted limiter and reader corrections.
- [ ] Update privacy and offer-contact wording to describe actual behavior. Keep account/offer workflows functional.
- [ ] Rerun focused tests, inspect the diff, commit owned files, and write a report listing changed interfaces and checks.

## Task 2: Reviewed feedback, evaluation, and honest rechecks

Own the feedback files listed in the spec, new modules/scripts, and tests/feedback*.test.js, tests/retest*.test.js, tests/evaluation*.test.js. Work in ../sutros-feedback.

- [ ] Write failing tests for private notes/public counts, separate anonymous voters, unauthorized review rejection, review history, conclusive-only exports, and malformed/unknown case handling.
- [ ] Write recheck fixtures for 404 followed by 404, 404 followed by 200, timeout, 429, redirect cycle, exhausted redirects, missing baseline, and unsupported finding types.
- [ ] Run `node --test tests/feedback*.test.js tests/retest*.test.js tests/evaluation*.test.js` and capture failures.
- [ ] Implement the exact shared API contract from the spec. Store reviews separately from signed reports and keep free text private until an explicit reviewer writes a public reason.
- [ ] Implement `scripts/evaluate-feedback.js --cases CASES --candidate CANDIDATE [--baseline BASELINE] [--out OUTPUT]` with explicit denominators, missing-case handling, and no network/model side effects.
- [ ] Verify persistence with a disposable local PostgreSQL database when available, not the production database.
- [ ] Rerun tests, commit owned files, and write the API/test report for frontend integration.

## Task 3: Coverage, immutable observations, scoring, and signatures

Own the reliability files listed in the spec and tests/reliability*.test.js, tests/reporter*.test.js, tests/signatures*.test.js. Work in a dedicated reliability worktree.

- [ ] Write failing tests where recon throws and a required planned check throws. Neither result may be graded A or called a completed clean checkup.
- [ ] Feed a writer result containing invented findings/passes and changed evidence. Original finding IDs, titles, meanings, evidence, passes, and severity must remain unchanged; optional aiAdvice is separate.
- [ ] Test an urgent agent finding and confirm it cannot change grade caps.
- [ ] Sign a version 2 fixture and mutate evidence, source, summary, coverage, and engine version independently. Each must invalidate the signature. Retain an independent version 1 fixture.
- [ ] Run the focused tests to observe the current failures, then implement coverage, assessment, source/timestamp/version provenance, the writer boundary, and signatures.
- [ ] Expose public assessment/coverage fields exactly as specified. Preserve all browser evidence fields created by Claude.
- [ ] Rerun tests, commit owned files, and report integration requirements.

## Task 4: Claude mobile rendering

Claude Fable 5.1 works in the original chat. Investigation output goes to the task work directory. Implementation uses ../sutros-mobile and the mobile-owned files in the spec.

- [ ] Compare the saved picture and scanner render with a normal phone-sized browser. Record resource outcomes and document the cause.
- [ ] Write a regression that fails for the proven cause and an inconclusive-render case that must not penalize the site.
- [ ] Apply the smallest validated fix without bypassing safety guards.
- [ ] Capture the corrected page, run focused tests, and deliver commits and evidence for review.

## Task 5: Terminology, report transparency, and review UI

Main worker owns the public integration files and tests/glossary*.test.js, tests/report-ui*.test.js. Work in the integration checkout.

- [ ] Write glossary tests for robots.txt and multiword aliases, longest-match handling, word boundaries, repeated dynamic rendering, and preserving existing interactive controls/raw URLs.
- [ ] Implement separate glossary data/behavior modules, an accessible in-place definition dialog, and an explanation of underlined terms.
- [ ] Render incomplete assessments and coverage before health claims. Show source/observation metadata and distinguish AI suggestions from measurements.
- [ ] Render the recheck's explicit working/broken/inconclusive classification; never infer correctness from a bare boolean.
- [ ] Update the feedback widget with private-note wording, review outcomes, and counts described as responses rather than verified people.
- [ ] Add an admin review view using the specified authenticated APIs, including the public-reason warning and dataset export. Add transparent aggregate progress without claiming model accuracy.
- [ ] Test with local fixture reports and review data, including malicious text, old reports, narrow screens, keyboard/Escape/focus behavior, and signed-out review access.

## Task 6: Integration and review

- [ ] Integrate the tested worker commits sequentially and resolve contracts, including serializer preservation of new fields.
- [ ] Add package.json test scripts for the actual checked-in tests. Run the full tests and targeted database/browser integration checks once all changes are present.
- [ ] Run the exact Lindgren reproduction and inspect the app on a phone viewport. Preserve before/after evidence and test results.
- [ ] Obtain independent code review of each area and the integrated branch. Fix reproducible issues and rerun the affected checks.
- [ ] Write a concise change report and reviewable diff. Handle any shared-branch or production action only after the completed result is reviewable.
