// feedback-ui.js  "Was this accurate?" under every finding and at the end of the report.
// Runs after core.js, app.js, auth-ui.js, and community-ui.js. It wraps
// Sutros.onReportRendered without replacing it, then fills every
// .f-slot[data-finding] and #reportFeedbackSlot that app.js left in the report.
// No sign-in is needed. Everything put into innerHTML goes through esc().
(function () {
  const S = window.Sutros;
  if (!S) return;

  const REPORT_LEVEL = "_report";
  const NOTE_MAX = 400;
  const FEEDBACK_PATH = (id) => "/api/reports/" + encodeURIComponent(id) + "/feedback";

  /* ---------------- small helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function ago(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    const months = Math.round(days / 30);
    if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  let seq = 0;
  function uid() {
    seq += 1;
    return "fbNote" + seq;
  }

  /* ---------------- state ---------------- */
  // current = { id, findings: { [findingId]: { right, wrong, notes } }, mine: { [findingId]: verdict } }
  let current = null;
  let mountSeq = 0;
  let pollTimer = null;
  let feedbackSeq = 0;

  function stateFor(fid) {
    const f = (current && current.findings && current.findings[fid]) || {};
    return {
      right: num(f.right),
      wrong: num(f.wrong),
      review: f.review || null,
      auto: f.auto || null,
      mine: current && current.mine && (current.mine[fid] === "right" || current.mine[fid] === "wrong") ? current.mine[fid] : null,
    };
  }

  function remember(fid, d) {
    if (!current) return;
    current.findings[fid] = { right: num(d.right), wrong: num(d.wrong), review: d.review || current.findings[fid]?.review || null,
      auto: d.auto || current.findings[fid]?.auto || null };
    if (d.mine === "right" || d.mine === "wrong") current.mine[fid] = d.mine;
  }

  /* ---------------- rendering ---------------- */
  function question(fid) {
    return fid === REPORT_LEVEL ? "Was this checkup accurate overall?" : "Was this accurate?";
  }
  function honeypot() {
    return `<input class="fb-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">`;
  }
  function countLine(st) {
    const total = st.right + st.wrong;
    if (!total) return "";
    return `<span class="fb-count">Unverified responses: ${esc(st.right)} yes, ${esc(st.wrong)} no</span>`;
  }
  function notesList(st) {
    const automatic = st.auto;
    const automaticLabel = { queued: 'Feedback queued', processing: 'Checking your feedback', processed: 'Feedback processed automatically', failed: 'Feedback processing could not finish' }[automatic?.status];
    const lessons = Array.isArray(automatic?.lessons) ? automatic.lessons.slice(0, 8).filter(item => typeof item?.text === 'string') : [];
    const automaticHtml = automaticLabel ? `<div class="fb-auto"><b>${esc(automaticLabel)}</b><p>${esc(automatic.summary || '')}</p>${lessons.length ? `<p class="fb-policy">Guidance for later checkups:</p><ul>${lessons.map(item => `<li>${esc(item.text)}</li>`).join('')}</ul>` : ''}</div>` : '';
    const review = st.review;
    const label = {confirmed:'Reviewer confirmed this finding',incorrect:'Reviewer found this finding incorrect',inconclusive:'Review could not confirm this finding'}[review?.status];
    const reviewHtml = label ? `<div class="fb-review ${esc(review.status)}"><b>${esc(label)}</b><p>${esc(review.reason || '')}</p><p class="fb-policy">Optional human review added ${esc(ago(review.reviewedAt) || 'at an unknown time')}. This is separate from automatic processing and the original report.</p></div>` : '';
    return `<div class="fb-status" aria-live="polite">${automaticHtml}${reviewHtml}<p class="fb-policy">Responses guide later checkups automatically. A vote alone does not prove a finding correct or incorrect.</p></div>`;
  }

  function idleHtml(fid, st) {
    return `<form class="fb-form" novalidate>
      <span class="fb-q">${esc(question(fid))}</span>
      <span class="fb-btns">
        <button type="button" class="fb-btn" data-v="right">Yes</button>
        <button type="button" class="fb-btn" data-v="wrong">No</button>
      </span>
      ${countLine(st)}
      ${honeypot()}
    </form>${notesList(st)}`;
  }

  function noteHtml(fid, st) {
    const id = uid();
    return `<form class="fb-form fb-open" novalidate>
      <span class="fb-q">${esc(question(fid))} <span class="fb-picked">You said no.</span></span>
      <label class="fb-label" for="${id}">What did you see? (optional, not published)</label>
      <textarea class="fb-note" id="${id}" maxlength="${NOTE_MAX}" rows="2"></textarea>
      <p class="fb-policy">The engine processes your note automatically and may send it to its AI provider. Your note and account name are not published. Avoid private information. <a href="/privacy">How feedback is used</a></p>
      <div class="fb-row">
        <button type="submit" class="fb-send">Send</button>
        <button type="button" class="fb-cancel">Cancel</button>
        <span class="fb-left">${NOTE_MAX} characters left</span>
      </div>
      <p class="fb-err" hidden></p>
      ${honeypot()}
    </form>${notesList(st)}`;
  }

  function doneHtml(fid, st) {
    return `<p class="fb-thanks">Your response was received. ${esc(st.right)} responses say this is right; ${esc(st.wrong)} say it is wrong.
      <button type="button" class="fb-change">Change my answer</button></p>${notesList(st)}`;
  }

  /** Draw one widget into a slot. mode: "idle" | "note" | "done" (default: done when the person already voted). */
  function draw(slot, fid, mode) {
    if (!slot) return;
    const st = stateFor(fid);
    const m = mode || (st.mine ? "done" : "idle");
    const box = document.createElement("div");
    box.className = "fb" + (fid === REPORT_LEVEL ? " fb-report" : "");
    box.dataset.finding = fid;
    box.innerHTML = m === "note" ? noteHtml(fid, st) : m === "done" ? doneHtml(fid, st) : idleHtml(fid, st);
    slot.innerHTML = "";
    slot.appendChild(box);
    wire(slot, fid, m);
  }

  function wire(slot, fid, mode) {
    const box = slot.firstElementChild;
    if (!box) return;
    if (mode === "idle") {
      box.querySelectorAll(".fb-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.v === "wrong") { draw(slot, fid, "note"); const ta = slot.querySelector(".fb-note"); if (ta) ta.focus(); return; }
          submit(slot, fid, "right", "", hpValue(box), box.querySelectorAll(".fb-btn"));
        });
      });
      return;
    }
    if (mode === "note") {
      const form = box.querySelector("form");
      const ta = box.querySelector(".fb-note");
      const left = box.querySelector(".fb-left");
      const update = () => { if (left && ta) left.textContent = Math.max(0, NOTE_MAX - ta.value.length) + " characters left"; };
      if (ta) ta.addEventListener("input", update);
      const cancel = box.querySelector(".fb-cancel");
      if (cancel) cancel.addEventListener("click", () => draw(slot, fid, "idle"));
      if (form) form.addEventListener("submit", (e) => {
        e.preventDefault();
        const note = ta ? ta.value.trim() : "";
        const err = box.querySelector(".fb-err");
        if (note.length > NOTE_MAX) { showErr(err, "Please keep the note to " + NOTE_MAX + " characters or fewer."); return; }
        submit(slot, fid, "wrong", note, hpValue(box), form.querySelectorAll("button"), err);
      });
      return;
    }
    const change = box.querySelector(".fb-change");
    if (change) change.addEventListener("click", () => draw(slot, fid, "idle"));
  }

  function hpValue(box) {
    const hp = box.querySelector("input[name=website]");
    return hp ? String(hp.value || "") : "";
  }
  function showErr(el, text) {
    if (!el) { S.toast(text); return; }
    el.textContent = text;
    el.hidden = false;
  }

  async function submit(slot, fid, verdict, note, website, buttons, errEl) {
    if (!current || !current.id) return;
    const id = current.id;
    const token = mountSeq;
    ++feedbackSeq;
    buttons.forEach((b) => { b.disabled = true; });
    const body = { findingId: fid, verdict };
    if (note) body.note = note.slice(0, NOTE_MAX);
    if (website) body.website = website;
    try {
      const d = await S.api(FEEDBACK_PATH(id), { method: "POST", body });
      if (token !== mountSeq || !current || current.id !== id) return; // a different report is on screen now
      ++feedbackSeq;
      remember(fid, d && typeof d === "object" ? { ...d, mine: d.mine || verdict } : { mine: verdict });
      draw(slot, fid, "done");
      schedulePoll(token);
    } catch (e) {
      if (token !== mountSeq || current?.id !== id) return;
      ++feedbackSeq;
      schedulePoll(token);
      buttons.forEach((b) => { b.disabled = false; });
      const msg = (e && e.message) || "We couldn't save that right now. Please try again.";
      if (errEl) showErr(errEl, msg); else S.toast(msg);
    }
  }

  /* ---------------- mounting ---------------- */
  function slots() {
    const root = document.getElementById("findingsRoot");
    const list = root ? Array.from(root.querySelectorAll(".f-slot[data-finding]")) : [];
    return list.filter((el) => {
      const fid = String(el.dataset.finding || "").trim();
      return Boolean(fid) && fid !== REPORT_LEVEL;
    });
  }

  function clear(list, reportSlot) {
    list.forEach((el) => { el.innerHTML = ""; });
    if (reportSlot) reportSlot.innerHTML = "";
  }

  function schedulePoll(token) {
    if (token !== mountSeq || !current) return;
    clearTimeout(pollTimer);
    if (!Object.values(current.findings).some(f => ['queued', 'processing'].includes(f.auto?.status))) return;
    pollTimer = setTimeout(async () => {
      if (token !== mountSeq || !current || !document.querySelector('#screen-report.is-active')) return;
      const id = current.id;
      const generation = feedbackSeq;
      try {
        const data = await S.api(FEEDBACK_PATH(id));
        if (token !== mountSeq || current?.id !== id) return;
        // A save may start or finish while this GET is in flight. Its earlier
        // snapshot must not replace the saved correction or stop its polling.
        if (generation === feedbackSeq) {
          current.findings = Object.assign(Object.create(null), data.findings || {});
          current.mine = Object.assign(Object.create(null), data.mine || {});
          // Update only status text. Keep open corrections, focus, and selected answers intact.
          for (const slot of [...slots(), document.getElementById('reportFeedbackSlot')].filter(Boolean)) {
            const box = slot.firstElementChild;
            const status = box?.querySelector('.fb-status');
            if (status) status.outerHTML = notesList(stateFor(box.dataset.finding));
          }
        }
      } catch { /* A transient read failure does not lose a saved answer or draft. */ }
      schedulePoll(token);
    }, 3000);
  }

  function mount(r) {
    clearTimeout(pollTimer);
    const list = slots();
    const reportSlot = document.getElementById("reportFeedbackSlot");
    clear(list, reportSlot);
    current = null;
    const token = ++mountSeq;
    if (!r || !r.id) return; // the sample report and unsaved reports have nothing to vote on
    const id = String(r.id);
    if (!list.length && !reportSlot) return;

    const show = () => {
      if (token !== mountSeq) return; // a newer report was rendered while we waited
      list.forEach((el) => draw(el, String(el.dataset.finding).trim()));
      if (reportSlot) draw(reportSlot, REPORT_LEVEL);
    };
    S.api(FEEDBACK_PATH(id)).then((d) => {
      if (token !== mountSeq) return;
      current = {
        id,
        findings: Object.assign(Object.create(null), d?.findings || {}),
        mine: Object.assign(Object.create(null), d?.mine || {}),
      };
      show();
      schedulePoll(token);
    }).catch((e) => {
      if (token !== mountSeq) return;
      if (e && (e.status === 503 || e.status === 404)) return; // nothing to vote on: no database, or the report is gone
      current = { id, findings: {}, mine: {} };
      show();
    });
  }

  /* ---------------- hook ---------------- */
  const prev = S.onReportRendered;
  S.onReportRendered = function (r) {
    if (typeof prev === "function") { try { prev.call(this, r); } catch (e) { console.error(e); } }
    try { mount(r); } catch (e) { console.error(e); }
  };
})();
