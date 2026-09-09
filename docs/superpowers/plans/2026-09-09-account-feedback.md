# Accounts and automatic feedback implementation plan

**Goal:** Require accounts for website checks and use feedback automatically in future scans.

**Architecture:** Existing authentication protects scan and recheck entry points. A persistent feedback worker processes responses into evidence-aware outcomes and fixed verification lessons. The pipeline supplies relevant lessons to its planner, browsing agent, and report advice writer.

**Tech stack:** Node22 ESM, Express, PostgreSQL, vanilla browser JavaScript, Playwright.

**Spec:** ../specs/2026-09-09-automatic-feedback-design.md

**Constraints:** Existing signed reports remain unchanged. Public report access and submitter privacy remain. Feedback processing needs no human approval. Free-text feedback cannot become instructions or suppress a fresh finding. All verification uses disposable databases and local fixtures before release.

## Account gates

Files: server/index.js, public/core.js, public/app.js, public/index.html, .env.example, tests/privacy-routes.test.js, test/report-evidence.test.js.

- Add route regressions: anonymous POST checkup, SSE checkup, and POST recheck return401 before DNS or target requests; an unverified account returns403; public reports return200; a verified account still gets JSON and SSE reports with private ownership omitted.
- Run the route suite on Node22 with LC_ALL=C and observe the missing gate failures.
- Apply requireVerified before prepare or recheck routing. Remove the anonymous policy switch and retain the existing20-check daily account limit. Report requireAccount:true in /api/config.
- Await Sutros.ready before scan/recheck actions, redirect to sign-in with the target/report retained, and update the account copy.
- Add a browser regression for sign-in navigation with no scan request and keep the signed-in recheck regression.
- Verify and commit.

## Automatic feedback backend

The backend implements the interfaces in the spec. Its files are server/feedbackAuto.js, server/feedbackLessons.js, an optional pure analysis module, the reusable observer export in server/retest.js, and new tests.

- Add failing tests for persistent jobs, both verdicts, report-wide inputs, changed/duplicate responses, concurrent/stale claims, budgets, retry limits, evidence interpretation, private-note exclusion, and future lesson retrieval.
- Implement fixed lesson templates, bounded evidence processing, atomic job lifecycle, automatic backlog reconciliation, and public outcome projection.
- Verify with disposable PostgreSQL and local HTTP fixtures, then commit for integration.

## Integration and public explanation

Files: server/index.js, server/feedback.js, server/feedbackReview.js, server/pipeline.js, server/orchestrator.js, server/checks/agentBrowse.js, server/reporter.js, public/feedback-ui.js, public/index.html, public/privacy.html, public/review-ui.js, tests for feedback/pipeline/model inputs.

- Add a route-to-worker-to-guidance integration test using a real saved feedback response and disposable PostgreSQL. Inspect the real model input through the existing scripted-model seams. Removing feedback enqueueing or lesson delivery must fail the test.
- Initialize schema and start the worker at server startup. POST feedback calls enqueueFeedbackCase(reportId,findingId); GET/POST responses attach auto outcomes. Add automatic progress separately from optional human reviews.
- Load lessonsFor({host}) before scan planning; pass feedbackLessons to planCheckup(facts,lessons), ctx.feedbackLessons for runAgentBrowse, and writeReport({...,feedbackLessons}). Each consumer uses formatFeedbackGuidance and publicGuidance rather than trusting supplied text.
- Include canonical applied guidance in report.engine.feedbackLearning before signing. Keep observations and scores independent of feedback votes.
- Display automatic processing and lessons in feedback widgets, refresh queued status without losing an open note, and explain private automated note processing and adaptive guidance in the page and privacy notice.
- Verify no raw notes appear in future prompts, public responses, or signed report guidance. Verify contradictory feedback cannot drop checks or suppress findings.
- Run focused tests and the complete211-test baseline plus new regressions under Node22.23.2. Review the combined changes, back up production, fast-forward the established main branch, deploy, and check account denial and real existing-feedback processing on production.

## Validation completed

The combined implementation passed all 268 tests on Node 22.23.2 with LC_ALL=C: 202 server tests and 66 browser tests, with no failures or skips. The feedback-to-future-scan test verifies real database persistence, model inputs, immutable original reports, and signed guidance. Independent review found a polling race; its failing regression and the preserved-draft test pass after the fix. Production release follows the backed-up deployment procedure.
