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
  const NOTES_SHOWN = 3;
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
  function people(n) {
    return n + (n === 1 ? " person" : " people");
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

  function stateFor(fid) {
    const f = (current && current.findings && current.findings[fid]) || {};
    const notes = Array.isArray(f.notes) ? f.notes.filter((n) => n && typeof n.text === "string" && n.text.trim()) : [];
    return {
      right: num(f.right),
      wrong: num(f.wrong),
      notes: notes.slice(0, NOTES_SHOWN),
      mine: current && current.mine && (current.mine[fid] === "right" || current.mine[fid] === "wrong") ? current.mine[fid] : null,
    };
  }

  function remember(fid, d) {
    if (!current) return;
    current.findings[fid] = { right: num(d.right), wrong: num(d.wrong), notes: Array.isArray(d.notes) ? d.notes : [] };
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
    return `<span class="fb-count">So far: ${esc(st.right)} yes, ${esc(st.wrong)} no</span>`;
  }
  function notesList(st) {
    if (!st.notes.length) return "";
    const items = st.notes.map((n) => {
      const who = n.by && String(n.by).trim() ? esc(String(n.by).trim()) + " wrote:" : "A visitor wrote:";
      const agoText = n.when ? ago(n.when) : "";
      const when = agoText ? `<time class="fb-when" datetime="${esc(n.when)}">${esc(agoText)}</time>` : "";
      return `<li><span class="fb-who">${who}</span> <span class="fb-text">${esc(n.text)}</span> ${when}</li>`;
    }).join("");
    return `<ul class="fb-notes">${items}</ul>`;
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
      <label class="fb-label" for="${id}">What did you see? (optional)</label>
      <textarea class="fb-note" id="${id}" maxlength="${NOTE_MAX}" rows="2"></textarea>
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
    return `<p class="fb-thanks">Thanks. ${esc(people(st.right))} said this is right, ${esc(st.wrong)} said it is wrong.
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
    buttons.forEach((b) => { b.disabled = true; });
    const body = { findingId: fid, verdict };
    if (note) body.note = note.slice(0, NOTE_MAX);
    if (website) body.website = website;
    try {
      const d = await S.api(FEEDBACK_PATH(id), { method: "POST", body });
      if (token !== mountSeq || !current || current.id !== id) return; // a different report is on screen now
      remember(fid, d && typeof d === "object" ? { ...d, mine: d.mine || verdict } : { mine: verdict });
      draw(slot, fid, "done");
    } catch (e) {
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

  function mount(r) {
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
        findings: d && d.findings && typeof d.findings === "object" ? d.findings : {},
        mine: d && d.mine && typeof d.mine === "object" ? d.mine : {},
      };
      show();
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
