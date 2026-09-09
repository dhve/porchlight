# Automatic feedback and testing improvements

A finding is a claim supported by an observation. Keep the observation, the
review decision, and the result of a later check separate. A later working page
does not establish what happened during the original checkup.

## Automatic processing

Right and wrong answers, optional notes, and report-wide feedback enter a
persistent queue. The worker starts with the server and recovers pending cases
after a restart. Changed answers are reconsidered; repeated identical answers
do not cause another model call. Human approval is not part of this loop.

The worker compares a response with saved evidence. For supported disputed
availability findings, it checks at most two recorded addresses using the same
public-address, redirect, and challenge guards as rechecks. A current answer
describes the site now. It does not prove an old observation was incorrect.
Other findings can produce verification guidance without an automatic recheck.

The model can select only fixed lesson IDs. Private notes are bounded, treated
as untrusted data, and sent only for this classification, without account
identifiers. Model failure uses conservative rules. Neither reader text nor
model-written instructions enter future scans. Lessons never disable checks,
rewrite signed reports, or directly change a finding's severity or grade.

The planner, browser agent, and advice writer receive relevant canonical
lessons. One processed case can activate guidance for its site. General guidance
requires support across at least three hosts and three signed-in accounts.
Superseded results are excluded and guidance expires after 90 days. This adapts
the engine's instructions; it does not train model weights. New reports record
the guidance and AI steps that used it in `engine.feedbackLearning`, covered by
the report signature.

The public progress endpoint separates automatic processing from optional
human reviews. Processing totals are not an accuracy score. Notes and account
identifiers are never included in public outcomes.

## Optional human review

1. A reader marks an individual finding right or wrong and can leave a private
   note. The saved response has a receipt. Votes are unverified signals; separate
   browsers do not necessarily represent separate people.
2. An existing administrator opens `/review`. Inspect the original evidence,
   its date, checker version, resource failures, and coverage. Use an independent
   browser or controlled reproduction when the recorded evidence is insufficient.
3. Choose confirmed, incorrect, or inconclusive, and explain the evidence. This
   explanation is public. Do not copy private notes or personal details into it.
   A new review is appended without changing the original signed report.
4. Download reviewed test cases. Only the latest confirmed or incorrect review
   for each finding becomes an evaluation label. Inconclusive reviews and votes
   do not become labels. Retain a fixed export for comparisons.

The reviewer needs an existing account with the administrator role. This change
does not promote an account automatically. The review API enforces that role;
the public page and its browser controls are not the permission boundary.

## Compare a proposed change

Prepare a versioned candidate result for the exported case IDs. Record `present`
when the candidate concludes that the specific issue exists, `absent` when it
concludes that it does not, or `inconclusive` when it could not assess it.
A check that did not run cannot be recorded as `absent`.

```json
{
  "schemaVersion": 1,
  "candidateVersion": "checker-change-1",
  "decisions": {
    "fc_example_case_id": "inconclusive"
  }
}
```

Replace the example ID with one from the export. Keep expected labels and review
reasons out of the observations supplied to the candidate. This repository
provides the evaluator, not an automatic candidate model runner. Generate the
decisions from a reproducible test of the proposed checker or agent, not by
copying the expected answers.

```sh
npm run evaluate-feedback -- \
  --cases reviewed-cases.json \
  --candidate candidate.json \
  --baseline baseline.json \
  --out comparison.json
```

The baseline file uses the same format. It is optional. Each input must be a
regular JSON file no larger than 10 MiB. The command rejects duplicate keys,
unknown case IDs, invalid labels, and inconsistent review metadata.

Inspect false positives, false negatives, missing decisions, explicit
inconclusive decisions, and the paired improvements and regressions. Metrics
include their numerator and denominator. Missing decisions cannot improve the
agreement count. A higher result on cases selected from feedback does not
establish overall accuracy across websites.

Before adopting a change, test it against a separate collection of known
working and broken fixtures, including refused requests, hosting bot checks,
missing styles, and incomplete scans. Keep some cases out of development and
compare both versions on the same held-out cases. Review regressions and changes
in coverage before release. Publishing real evaluation results remains an
explicit operator step; the app does not invent improvement statistics.

## Storage and signatures

New reports use version 2 signatures covering public findings, evidence, source,
advice, artifact hashes, summary, coverage, assessment, and engine metadata.
Version 1 reports retain their original narrower verification rules. The public
verification endpoint is `/api/verify/:id`. A signature establishes origin and
integrity. It does not establish correctness or fetch current picture bytes.

Review snapshots retain the public observation and exclude private submitter
information and feedback. Historical reviews are not rewritten. A new review
is needed to capture evidence fields that an older snapshot omitted.

Feedback identity uses `FEEDBACK_COOKIE_SECRET`, then `SESSION_SECRET`, then a
private database key initialized at startup. Preserve that key with database
backups and keep configured secrets consistent across workers. Changing the
key changes browser digests. The cookie lasts up to 90 days; the stored value
is a keyed digest rather than the raw cookie. Connection limits remain separate.

Automatic guidance and human evaluation labels serve different purposes.
Feedback changes verification instructions automatically. The optional
evaluation workflow can measure a proposed checker change against retained
cases, without treating votes or automatic outcomes as ground-truth labels.
