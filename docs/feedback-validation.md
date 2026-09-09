# Reviewing findings and testing improvements

A finding is a claim supported by an observation. Keep the observation, the
review decision, and the result of a later check separate. A later working page
does not establish what happened during the original checkup.

## Review a response

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

User feedback does not automatically fine-tune a model, modify prompts, or
approve a deployment. The loop is response, evidence review, retained case,
candidate comparison, and a reviewed change.
