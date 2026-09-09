# Sutros evidence, privacy, and feedback

The user requested stronger proof of findings, anonymous use with public transparency, a feedback loop that improves the checker, a fix for the incorrect mobile rendering of https://thelindgrengroup.com/quality/, and clickable definitions of unfamiliar terms. Claude must collaborate in the existing "Website vulnerability scanning MVP" chat using Fable 5.1.

## Product decisions

Public checkups expose the website observations and review outcomes. They do not expose the submitter's account identity. Anonymous use means no account is required and no submitter identity is published. It does not mean the server cannot see a connection's IP address. Abuse protections and data retention must be described accurately.

An automated observation is evidence to inspect, not a guarantee that a website is unsafe or safe. A failed or incomplete checker must never produce a clean A result. AI browsing notes and AI suggestions must be clearly separate from scripted observations and must not change the grade.

Votes are reports from readers, not verified labels. Free-text feedback is private to reviewers. Public totals and review outcomes remain visible. An authorized reviewer must state why a finding is confirmed, incorrect, or still inconclusive. Reviewed cases can be exported into an evaluation dataset. Candidate changes are compared against those cases before release. No automatic model training or production prompt changes occur from votes.

The mobile bug must be diagnosed by comparing actual resource loading and rendering. If the checker's browser did not load a usable page, the result is inconclusive and must not penalize the website. The fix must preserve network safety guards.

Unfamiliar web terminology receives an underlined button that opens a definition in place. It must work by touch and keyboard, including Escape and focus return. Definitions must also work on dynamically rendered findings and minor notes. Existing links, controls, and raw evidence must keep their behavior.

## Work areas and ownership

All work starts from f1a6bd5. Each worker has an isolated checkout under this task's work directory. The original repository and production remain available during development. Changes are integrated and reviewed before any shared-branch or production action.

1. Privacy: public serialization, ownership capabilities, URL input privacy, abuse limiter accuracy, bounded response reads, privacy copy. Owns server/publicReport.js, server/db.js, server/index.js, server/bulletin.js, server/ratelimit.js, server/safety.js, server/lib/http.js, public/privacy.html, public/auth-ui.js, and public/community-ui.js. Feedback and general home copy are separate integration tasks.
2. Feedback and rechecks: owns server/feedback.js, server/retest.js, new feedback review/evaluation modules and scripts, and relevant tests. No changes to db.js or index.js; use existing mounted routers and local schema initialization.
3. Reliability: owns server/pipeline.js, server/reporter.js, server/scoring.js, server/explain.js, server/verify.js, server/signing.js, new provenance helpers, and relevant tests. No browser/proof or public UI edits.
4. Claude mobile: owns server/checks/browser.js, server/checks/modernization.js, server/checks/agentBrowse.js, server/proof.js, server/lib/browserConnect.js and focused browser render helpers/tests, after the diagnostic result establishes the cause.
5. Main integration: owns public/app.js, public/index.html, public/styles.css, public/feedback-ui.js, public/feedback.css, new glossary and review UI modules, package.json test commands, documentation, and integration tests.

## Shared interfaces

### Public report

Export `publicReport(report, viewer = null)` from server/publicReport.js. Preserve public report fields, including new `assessment`, `coverage`, `engine`, evidence, and attestation metadata. Remove submitter IDs, account names, private notes, and other private identity fields. Public endpoints and SSE must use the same projection. Ownership controls use server-derived booleans, never exposed account IDs. Internal storage may keep user_id for account features. Signature payloads do not include private submitter information.

### Coverage and provenance

New reports expose `coverage` as an array of `{check, status, reason?}`. Status is `completed`, `skipped`, `failed`, or `inconclusive`. Preserve existing checksRun for compatibility. The assessment is `{status: "complete"|"incomplete", reason}`. If recon fails or a required planned deterministic check fails, use grade `?`, label `Not rated`, score null, and ringPercent 0. Optional agent/browser unavailability must be explained, with no fabricated pass. The reports.score column must allow null for unrated reports.

Preserve timestamps, detector identity, and actual measured evidence. Include an implementation version in engine metadata. New signatures use version 2 and cover the public findings, their evidence/source, passes, coverage, assessment, summary, and engine metadata through stable canonical hashes. Keep version 1 verification working for old reports and explain its narrower coverage. A signature proves origin and unchanged content, not factual correctness.

The writer cannot replace scripted title/meaning/evidence/pass results. Any useful model-generated explanation or fix goes into a distinct `aiAdvice` object on the corresponding original finding. Invented IDs are ignored. The report's health summary remains deterministic. No agent finding can affect scoring caps, even if a malformed agent result carries urgent/serious severity.

### Feedback

Existing feedback GET/POST routes remain compatible for counts and the visitor's vote, but never publish free-text notes or contributor names. Add `policy` explaining private notes and unverified votes, plus a receipt/received state after submission. Anonymous browser identity should not collapse every visitor behind the same IP into one vote; use an unguessable functional cookie and a server-side keyed digest, with separate IP-based abuse limits. Do not treat browser count as verified unique people.

Add an admin-only review queue and adjudication route under the existing feedback router. `GET /api/feedback/review-queue` returns `{cases:[...]}` with reportId, findingId, finding/evidence snapshot, feedback counts, private notes, and latest review. `POST /api/reports/:id/feedback/review` accepts `{findingId,status,reason}` where status is `confirmed`, `incorrect`, or `inconclusive`, and reason is a required substantive explanation that will be public. Use an append-only review history. Keep the signed original report unchanged.

Each public feedback entry may include `review:{status,reason,reviewedAt}`. No reviewer account ID is public. Add `GET /api/feedback/progress` with aggregate counts of submitted signals and reviewed cases, and explicit statements that these are not overall model accuracy. Add admin-only `GET /api/feedback/evaluation-cases` exporting the latest confirmed/incorrect decisions, stable case IDs, report/finding snapshots, expected `present`/`absent`, and provenance. Inconclusive cases do not become ground truth.

The evaluation CLI consumes an exported cases file and candidate decisions keyed by caseId. A decision is `present`, `absent`, or `inconclusive`, with candidate version. Missing cases count as inconclusive, never as successes. Report confusion counts, decided coverage, and agreement on reviewed cases, with explicit denominators. An optional baseline permits a paired comparison. Never describe these selected reviewed cases as the true accuracy across the web. Include a report-to-candidate adapter only if it can distinguish a missing finding from a check that did not run.

### Rechecks

Only supported availability findings can be rechecked by an HTTP availability probe. Export `retestCapability(finding)` from server/retest.js, returning `{supported, scope, reason}`. Findings about layout, keys, source maps, headers, or AI observations must not be declared correct/incorrect by a generic GET. Unsupported requests return a clear 422 response. Completed responses include `scope`, `checkedAt`, and items with `classification: "broken"|"working"|"inconclusive"`, `changed: boolean|null`, and the measured status. Redirect loops, exhausted redirects, access refusal, rate limiting, timeouts, and unknown baseline status are inconclusive. Do not interpret 200 as validation of a non-availability finding.

### Glossary and feedback UI

Use separate public glossary data and behavior modules. The dictionary covers terms used by the app, including robots.txt, sitemap, HTTP/HTTPS, status codes, TLS/SSL, cookies, headers, CSP/CORS/HSTS, CSRF/XSS, SRI, API keys, source maps, DNS, OAuth, signatures, viewport, JavaScript, CSS, HTML, CDN, and LLM. Definitions are short and factual. In particular, robots.txt asks cooperating crawlers what they may visit; it is not access control and does not guarantee a page will stay out of search results. Sources: [Google robots.txt guidance](https://developers.google.com/search/docs/crawling-indexing/robots/intro) and [MDN web terminology](https://developer.mozilla.org/en-US/docs/Glossary).

Feedback UI explains that notes are private and votes await review. Show public review status and reasons separately from the original signed report. Provide an admin review screen with explicit public-reason wording, role checks enforced server-side, and evaluation export. Explain the improvement process in ordinary language. The test-case approach follows [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices); it does not claim automatic fine-tuning.

## Acceptance checks

- The exact mobile bug has reproducible before/after evidence or a clearly stated environmental limit. An incomplete render never becomes a negative mobile finding.
- The primary public report routes, SSE, recent lists, dedup responses, and bulletin embedding do not expose private submitter fields.
- Two anonymous browsers on one network can submit independent feedback; abuse caps still apply. Raw notes remain private.
- Unauthorized review attempts fail. Reviews persist without rewriting the original signed report. Only reviewed conclusive cases export as labels.
- The evaluation CLI counts missing/inconclusive cases and fails malformed input. Fixtures catch both false positives and false negatives.
- A recon exception or required-check failure produces an unrated result. AI advice cannot alter measured findings/passes/grade. Changes to signed evidence invalidate version 2 signatures; old signatures still verify under version 1 rules.
- A URL returning 200 cannot prove that a layout/secret/header claim was correct. Inconclusive HTTP outcomes remain inconclusive in the UI.
- Definitions work in desktop and phone layouts, with keyboard access, dynamic content, and no nested links/buttons or HTML injection.
