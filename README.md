# Sutros

**A friendly, community-driven website checkup for small businesses.**

Point Sutros at a website you own or are permitted to test. It gently
checks the site the way a customer would, then hands back a plain-language
health report: what is broken, what is risky, and how to fix it. The corner
bakery running a five-year-old website deserves the same safety as a big
company, and shouldn't need to know what "XSS" means to get it.

Sutros is built as an authorized-testing tool. It is consent-based,
read-only, and detects issues rather than exploiting them.

## What it does

You give it a URL and confirm you have permission. It runs a checkup in five
steps and produces a report graded A to F, or Not rated when required checks
cannot finish. Each finding includes the recorded observation, an explanation,
and steps to confirm it. The report covers the sampled checks, not every possible
problem on a website.

## How the engine works

Sutros combines a deterministic workflow with an LLM that acts as the
planner and the writer. The reliable, factual work is scripted. The judgment
and the plain-language write-up use the model.

```
  1. Recon         deterministic   Fetch the homepage once, fingerprint the
                                   stack, versions, headers, and TLS.
  2. Orchestrator  LLM             Read what recon found, decide which checks
                                   to run and in what order, prioritize by
                                   likely impact.
  3. Checks        deterministic   Scripted, repeatable probes (see below).
  4. Agent         optional        A headless-browser pass that navigates the
                                   site like a visitor and watches for errors.
  5. Reporter      LLM             Turn the structured findings into a warm,
                                   plain-language report. Grade is computed
                                   deterministically, never by the model.
```

Scripted findings and the grade remain separate from AI advice. The writer can
add advice to a known finding but cannot replace its recorded observation,
evidence, or severity. Optional browsing-agent notes are labeled and cannot
change the grade. Scripted checks can also be wrong; a signature verifies the
report's origin and integrity, not whether its conclusions are correct.

**It runs without an API key.** With no key, the orchestrator runs every check
and the report uses built-in plain-language templates. Add a key and the smart
planner and natural-language write-up turn on automatically.

## What it checks

Sutros crawls several pages (plus `robots.txt` and `sitemap.xml`) and runs a
deep, read-only analysis across these areas:

**Encryption and transport**
- Certificate validity, expiry, key strength, and self-signed certificates
- Deprecated TLS 1.0 / 1.1 still being accepted
- HTTPS enforcement (HSTS) and its strength, plus mixed content

**Server and browser hardening**
- Every standard security header, and the *quality* of the ones present
  (weak Content-Security-Policy, short HSTS)
- CORS misconfiguration (wildcard origin, or wildcard combined with credentials)
- Per-cookie Secure / HttpOnly / SameSite flags, with extra weight on session cookies

**Exposed data and information leaks**
- ~30 well-known private paths (`.env`, `.git`, database backups, `wp-config`
  backups, cloud credentials, SSH keys, debug logs, `phpinfo`, and more)
- Secrets and API keys accidentally left in page source (AWS, Google, Stripe,
  GitHub, Slack, JWTs, private keys)
- Published source maps, directory listings, verbose error / stack traces, and
  sensitive paths leaked through `robots.txt`

**Vulnerable components**
- Front-end libraries (jQuery, Bootstrap, Angular, Lodash, and others) running
  versions with known public advisories, the Retire.js approach
- Outdated CMS (WordPress and friends)

**Application behavior**
- Password forms that submit insecurely, missing CSRF tokens, password fields
  set to autocomplete, and external scripts loaded without Subresource Integrity
- A conservative reflected-input (XSS surface) check that flags where a site
  echoes input back unescaped, for a developer to review
- Key customer pages (order, book, contact) that error, plus broken links and images
- With the optional browser agent: JavaScript errors, load speed on a phone,
  and images that fail to render

**Detection, not exploitation.** A possible exposed file is identified from a
sample of up to 4,000 response bytes. The remaining response is canceled and
the sampled content is not stored in the report. The reflected-input check uses a
harmless marker and never injects anything that executes. No form is ever
submitted and nothing on the site is changed.

## Quick start

Requires Node 18 or newer.

```bash
git clone https://github.com/dhve/porchlight.git
cd porchlight
npm install
cp .env.example .env      # optional: add your OpenAI key inside
npm start
```

Then open http://localhost:3000

### Adding your OpenAI key (the safe way)

Never paste your key into a chat or commit it to git. Instead:

1. Open the `.env` file you created above.
2. Set your key:
   ```
   OPENAI_API_KEY=sk-your-key-here
   OPENAI_MODEL=gpt-4o-mini
   ```
3. Restart the server. On start it prints whether the LLM is on.

`.env` is listed in `.gitignore`, so the key stays on your machine and is never
pushed.

### Saving reports with Postgres (optional)

Set `DATABASE_URL` in `.env` and Sutros saves every checkup, gives each
report a shareable link like `/r/abc123xyz0`, and lists recent reports at
`/api/reports`. The table is created automatically on first start. Without a
database everything still works, reports just are not kept.

```
DATABASE_URL=postgres://porchlight:password@localhost:5432/porchlight
```

### Turning on the browser agent (optional)

The deeper "acts like a customer" pass uses Playwright, which is heavy, so it is
optional. To enable it:

```bash
npm run enable-browser
```

Without it, Sutros still runs a lighter customer-flow check that works over
plain HTTP requests.

## API

Both endpoints require an explicit `consent` flag and pass every target through
the safety guards before any request is made.

- `GET /api/checkup/stream?url=<site>&consent=1` streams live progress and the
  final report as Server-Sent Events (this is what the UI uses).
- `POST /api/checkup` with JSON `{ "url": "<site>", "consent": true }` runs the
  same checkup and returns the report as one JSON response.
- `GET /api/health` reports whether the LLM and database are configured.
- `GET /api/reports` lists recent saved reports (needs a database).
- `GET /api/reports/:id` returns one saved report; `/r/:id` is its share link.

## Evidence and reviewed feedback

Reports list completed, failed, skipped, and inconclusive checks. A hosting bot
check or incomplete browser render cannot establish a visual defect. Supported
address rechecks test availability only; they cannot validate layout, headers,
or exposed-secret claims.

No account is required for checkups or feedback when `REQUIRE_ACCOUNT=0`.
Public reports omit submitter identity. Feedback notes are private to authorized
reviewers, while response totals and separate review explanations are public.
Anonymous use does not hide the connection address from the service.

Reviewers use `/review` to adjudicate findings and export conclusive cases.
The offline evaluation command compares explicit candidate decisions with those
cases and an optional baseline. Votes never train a model or change prompts
automatically. See [the review and evaluation guide](docs/feedback-validation.md)
for the workflow, input format, and limits.

Run `npm test` to check privacy, coverage, signatures, feedback, evaluation, and
browser rendering. The tests use a disposable local PostgreSQL cluster and
Chromium; they do not scan production websites or invoke a model. The suite was
verified on Node 25.6.1 and needs Node's experimental module-mock support.

## Deploying to a VPS

`deploy/` holds a re-runnable install for an Ubuntu box (used for the live
instance on a DigitalOcean droplet). It installs Node 22, Postgres, Chromium for
the browser agent, creates a locked-down `porchlight` system user, writes the
`.env`, and registers a systemd service on port 3300.

```bash
# from your machine, with SSH access to the server as root
./deploy/run-deploy.sh
```

The runner copies only the `OPENAI_*` lines from your local `.env` over SSH (the
key is never printed), then runs `deploy/deploy-porchlight.sh` on the server. To
redeploy after a code change:

```bash
ssh root@<server> "cd /opt/porchlight && sudo -u porchlight git pull && systemctl restart porchlight"
```

## Safety and responsible use

Anyone can check any public website: the checks only read what a visitor's browser can already see, and every checkup is public.

- **Public by design.** Every checkup is public, and reports never include the
  contents of exposed files or secret values.
- **Read-only.** It makes ordinary GET requests and one read-only TLS handshake.
  It does not submit forms, complete purchases, or change anything on the site.
- **Detection, not exploitation.** Possible exposed files are checked using a
  bounded response sample. The report does not keep those file contents.
- **Polite.** Requests are capped per checkup, time-limited, and sent with an
  honest `SutrosBot` user agent.
- **No internal targets.** The scanner refuses localhost, private networks, and
  reserved addresses, so it can't be aimed at internal services.

## Project structure

```
server/
  index.js              Express app, static hosting, SSE + JSON endpoints
  safety.js             URL validation, SSRF guard, scan limits
  llm.js                OpenAI wrapper (plain fetch, JSON mode)
  orchestrator.js       LLM planner (rule-based fallback)
  reporter.js           LLM report writer (template fallback)
  scoring.js            Deterministic A to F grade
  db.js                 Optional Postgres persistence and share links
  pipeline.js           Runs the whole checkup, emits progress
  lib/http.js           Polite HTTP client with a request budget
  checks/               recon, tls, security, exposedFiles, flows, links, browser
public/
  index.html            The three screens: intake, live run, report
  styles.css
  app.js                Streams the checkup and renders the report
```

## Roadmap

- Confirm detected versions against a live vulnerability database
- Re-scan saved sites on a schedule, with a "verified healthy" badge
- The community layer: nominate a local business, match with vetted helpers
- Email a report as a shareable PDF

## License

MIT. See [LICENSE](LICENSE).
