# Accounts and automatic feedback design

Website checks require a verified account. Reader feedback automatically guides future verification without mandatory human review. Saved reports remain public, with submitter identity kept private.

## Behavior

Process right and wrong responses, notes, and report-wide responses. New and existing feedback enter a persistent queue. Changes to an answer cause reconsideration. Identical submissions do not cause repeated AI calls. A late worker cannot publish a result for superseded feedback. A queued case survives restart; expired claims can be recovered; retries and daily processing are bounded.

Automatic processing reads the saved report and feedback as data. For supported availability findings, inspect at most two recorded addresses through the existing public-address, redirect, and challenge guards. A fresh response describes now. It cannot prove the historical site changed or establish that an old observation was wrong. Original no-HTTP-response evidence supporting an HTTP-error claim can be classified as unsupported. Other cases remain inconclusive or feedback-only while still producing useful verification guidance.

AI may classify feedback into fixed lesson codes. It must not write arbitrary instructions for later scans, accept a vote as fact, disable a check, suppress a new finding, change severity, or rewrite signed reports. Do not build a new browser replay subsystem. Do not equate a failure to reproduce now with a historical mistake. Human reviews remain optional, separate records; they are not required for feedback processing or guidance activation. Human evaluation exports remain a separate source of labels.

Raw notes and identities never appear in public outcomes or future prompts. The current processing call may receive bounded notes as clearly delimited untrusted data, with no account identity. Public summaries and future guidance come from a fixed code-owned template catalog. An unavailable or invalid model response uses a conservative rule-based fallback. Lessons guide verification; they never establish factual correctness.

## Backend interfaces

`server/feedbackLessons.js` exports:

- `LESSON_CATALOG`: fixed code-to-template mapping covering availability, incomplete rendering, interaction verification, direct evidence, context, and other useful verification patterns.
- `formatFeedbackGuidance(lessons)`: validate IDs against the catalog and return bounded canonical text. Ignore caller-supplied free text.
- `publicGuidance(lessons)`: bounded array of `{id, scope, text}` using canonical templates only.

`server/feedbackAuto.js` exports:

- `ensureAutoFeedbackSchema()` initializes additive tables after finding_feedback exists.
- `enqueueFeedbackCase(reportId, findingId)` reconciles that case with the current feedback revision, without enqueuing identical inputs twice.
- `startFeedbackWorker({intervalMs = 5000, ...testDependencies} = {})` starts bounded polling and returns `{stop(), tick()}`. No worker starts on module import. Recover existing feedback at startup and reconcile missed queue entries periodically. Do not require an administrator action.
- `processFeedbackJob(options = {})` claims and processes at most one case; expose injected model/observer seams for tests. Return enough result information for testing.
- `autoFeedbackForReport(reportId)` returns an object keyed by finding ID, including `_report`. Each value is `{status, outcome, processedAt, summary, lessons}`. Status is queued, processing, processed, or failed. Outcome is unsupported, reproduced, different-now, inconclusive, or feedback-only. Lessons use `{id,scope,text}` from the fixed catalog. Public summaries contain no raw note, title copied from a note, model-generated prose, account identity, or private error detail.
- `autoFeedbackProgress()` returns `{submitted, processed, pending, failed, lessonsActive, mode: 'automatic'}`. Submitted includes report-wide cases.
- `lessonsFor({host, limit = 8})` returns relevant current lessons as `{id, scope, text}`. Site guidance can activate automatically from one processed case. General guidance requires the same pattern across at least three distinct hosts and three distinct signed-in accounts. Ignore superseded results and expire lessons after 90 days. Never include raw notes or identities.

`server/retest.js`: export `observeRecordedAddress(rawUrl, {resolve, makeClient, allowPort} = {})` using the existing parseHttpUrl/allowed/fetchStatus behavior. Production defaults keep public HTTP(S) addresses on ports80/443, redirects checked at every hop, challenges and transport failures inconclusive. This helper does not compare a historical baseline or save an attempt. Do not change route behavior.

Implementation may use one current job per report/finding plus an append-only processed-result table. Claim/finish must be atomic and guarded by a claim token and feedback revision. Keep finite attempts and lease duration beyond the bounded model/observer runtime. Avoid one giant new module; separate pure analysis from storage/worker code if necessary. Daily global and host budgets apply to automatic network/model work, with queued work deferred until the next window. Conservative no-network/no-model rule processing may complete under budget exhaustion.

Tests use disposable PostgreSQL and local fixture servers. Required cases: both verdicts and report-wide inputs; duplicate submission; changed feedback during processing; concurrent claim; stale claim; retry limit; restart/reconciliation; budget; legacy status0; current200 after old404 is different-now and not historical incorrect; transport/challenge/private redirect protection; invalid/injected model output; private-note exclusion; signed report unchanged; actual saved lessons retrieved for later scan input. Use Node22.23.2 and LC_ALL=C. No production database or API key in tests.

## Application integration

Initialize schema and worker after feedback setup. POST feedback enqueues the case; GET/POST responses expose its separate `auto` result. Add automatic progress to the existing public progress endpoint without presenting automatic outcomes as human labels. Future scans load lessons by host once and pass them to the planner, browser agent, and advice writer; canonical formatting prevents arbitrary memory text. Include applied guidance in report.engine.feedbackLearning before signing so readers can inspect what influenced the run.

Require a verified account for scans and rechecks before network preparation. Public report and feedback reading stay available. Account identity remains private in public reports. Update UI and privacy descriptions to explain automated note processing and adaptive guidance, with no claim that model weights are retrained or accuracy is measured by vote counts. Preserve existing authentication providers and report URLs.
