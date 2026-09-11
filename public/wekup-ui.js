// Private, account-bound conversation and public reassessments beside signed evidence.
(function () {
  const S = window.Sutros;
  if (!S) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = '<svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="m5 9 4 11 5-8 5 8 4-11" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 5h2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
  const arrow = '<svg class="site-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 17 17 7M7 7h10v10"/></svg>';
  const LABELS = { supported: 'Supported in this check', 'not-reproduced': 'Not seen in this sample', inconclusive: 'Still needs verification', unsupported: 'Original claim lacks support' };
  const host = document.createElement('div');
  host.id = 'wekupWidget';
  host.innerHTML = `<button type="button" class="wekup-launcher" aria-label="Talk to wekup" aria-haspopup="dialog" aria-expanded="false" aria-controls="wekupDialog"><span class="wekup-mark">${icon}</span><span>Talk to <b>wekup</b></span>${arrow}</button>
    <dialog id="wekupDialog" class="wekup-dialog" aria-labelledby="wekupTitle">
      <header class="wekup-header"><span class="wekup-mark">${icon}</span><div><h2 id="wekupTitle">wekup</h2><p>Sutros's AI website checkup</p></div><button type="button" class="wekup-close" aria-label="Close wekup">×</button></header>
      <div class="wekup-context"><label for="wekupFinding">Discuss</label><select id="wekupFinding" aria-label="Finding to discuss"></select></div>
      <div class="wekup-body" tabindex="0"><div class="wekup-intro"></div><div class="wekup-messages" role="log" aria-label="Your conversation with wekup" aria-live="polite" aria-relevant="additions text"></div><div class="wekup-current"></div></div>
      <p class="wekup-status" role="status" hidden></p>
      <p class="wekup-error" role="alert" hidden></p>
      <div class="wekup-gate"></div>
      <form class="wekup-composer"><label class="wekup-sr" for="wekupMessage">Message wekup</label><div class="wekup-input-row"><textarea id="wekupMessage" maxlength="1600" rows="2" placeholder="Tell me what you see, or ask a question…"></textarea><button type="submit" class="wekup-send" aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5m-6 6 6-6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><p class="wekup-private">Private chat. AI replies may be wrong. Evidence checks and verification guidance are public. <a href="/privacy#wekup">How responses are used</a></p></form>
    </dialog>`;
  document.body.appendChild(host);
  const $ = selector => host.querySelector(selector);
  const dialog = $('#wekupDialog'), launcher = $('.wekup-launcher'), input = $('#wekupMessage');
  const select = $('#wekupFinding'), messages = $('.wekup-messages'), body = $('.wekup-body');
  let report = null, context = null, state = null, token = 0, requestSequence = 0, timer = null;
  let posting = false, retry = null, returnFocus = launcher, renderedMessages = '';
  let accountId = S.user?.id || null, accountVerified = Boolean(S.user?.emailVerified), reportVersion = 0, publicSequence = 0;
  const drafts = new Map(), assessments = new Map(), pendingRequests = new Map();
  const busy = () => posting || ['queued', 'processing'].includes(state?.job?.status);
  const eligible = () => Boolean(S.user?.emailVerified && context?.reportId);
  const path = () => '/api/reports/' + encodeURIComponent(context.reportId) + '/wekup';
  const visibleReport = () => document.getElementById('screen-report')?.classList.contains('is-active') ? report : null;
  const saveDraft = () => { if (context) drafts.set(context.key, input.value); };
  function stopPoll() { clearTimeout(timer); timer = null; }
  function error(text = '') { $('.wekup-error').textContent = text; $('.wekup-error').hidden = !text; }
  function time(iso) { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time not recorded'; }
  function safeUrl(raw) { try { const u = new URL(raw); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } }
  function assessmentHtml(a) {
    if (!a || !LABELS[a.status]) return '';
    const evidence = Array.isArray(a.evidence) ? a.evidence.slice(0, 8) : [];
    const lessons = Array.isArray(a.lessons) ? a.lessons.slice(0, 8) : [];
    return `<div class="wekup-assessment-head"><span class="wekup-mini-mark">${icon}</span><div><b>${esc(LABELS[a.status])}</b><small>wekup reassessment, ${esc(time(a.checkedAt))}</small></div></div><p>${esc(a.summary || '')}</p><details><summary>What wekup checked</summary><p>${esc(a.method || 'See the observations below.')}</p>${evidence.length ? `<ul>${evidence.map(e => `<li>${safeUrl(e.url) ? `<a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${esc(e.url)}</a>` : ''}<span>${esc(e.detail || '')}</span></li>`).join('')}</ul>` : '<p>No new page observation was available.</p>'}${lessons.length ? `<p>Verification reminders from this conversation:</p><ul>${lessons.map(l => `<li>${esc(l.text || '')}</li>`).join('')}</ul>` : ''}<p class="wekup-limit">A new observation applies to this sample and time. The original report and grade remain on record.</p></details>`;
  }
  function rememberAssessment(a) {
    if (!report?.id || !a || !LABELS[a.status]) return;
    const previous = assessments.get(a.findingId);
    if (previous && Date.parse(previous.checkedAt) > Date.parse(a.checkedAt)) return;
    assessments.set(a.findingId, a);
    document.querySelectorAll('.wekup-assessment[data-finding]').forEach(slot => {
      if (slot.dataset.finding !== a.findingId) return;
      slot.innerHTML = assessmentHtml(a); slot.hidden = false;
    });
    const overview = document.getElementById('wekupReportStatus');
    if (overview) overview.textContent = assessments.size + (assessments.size === 1 ? ' finding has' : ' findings have') + ' a newer assessment below. The original grade is shown above.';
  }
  async function loadPublic() {
    const id = report?.id, version = reportVersion, seq = ++publicSequence;
    if (!id) return;
    try {
      const data = await S.api('/api/reports/' + encodeURIComponent(id) + '/assessments');
      if (version !== reportVersion || seq !== publicSequence || report?.id !== id) return;
      for (const [fid, a] of Object.entries(data?.assessments || {})) rememberAssessment({ ...a, findingId: fid });
    } catch { /* Existing reports remain readable when reassessment retrieval is unavailable. */ }
  }
  function paint() {
    const rows = Array.isArray(state?.messages) ? state.messages.slice(-60) : [];
    const signature = JSON.stringify(rows);
    if (signature !== renderedMessages) {
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 100;
      messages.innerHTML = rows.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `<article class="wekup-message ${m.role === 'user' ? 'from-user' : 'from-wekup'}"><span class="wekup-speaker">${m.role === 'user' ? 'You' : 'wekup'}</span><p>${esc(m.text)}</p></article>`).join('');
      renderedMessages = signature;
      if (nearBottom) body.scrollTop = body.scrollHeight;
    }
    $('.wekup-current').innerHTML = state?.assessment ? `<div class="wekup-chat-assessment">${assessmentHtml(state.assessment)}</div>` : '';
    const status = $('.wekup-status');
    status.hidden = !busy();
    status.textContent = busy() ? (state?.job?.stage || 'Sending your message…') : '';
    if (state?.job?.status === 'failed') error(state.job.error || 'Wekup could not finish this check. You can send another message to try again.');
    $('.wekup-send').disabled = !eligible() || busy() || !input.value.trim();
    if (state?.assessment && context?.reportId === report?.id) rememberAssessment(state.assessment);
  }
  function accept(data, mine) {
    if (mine !== token || !context || !data || data.reportId !== context.reportId || data.findingId !== context.findingId) return false;
    if (state && Number(data.revision) < Number(state.revision)) return false;
    state = data; paint(); return true;
  }
  function schedule() {
    stopPoll();
    if (dialog.open && eligible() && busy() && !posting) timer = setTimeout(loadConversation, 1500);
  }
  async function loadConversation() {
    if (!eligible() || !dialog.open) return;
    const mine = token, seq = ++requestSequence;
    try {
      const data = await S.api(path() + '?findingId=' + encodeURIComponent(context.findingId), { expectedAccount: accountId });
      if (mine !== token || seq !== requestSequence) return;
      if (accept(data, mine)) { if (state?.job?.status !== 'failed') error(); if (!busy()) loadPublic(); }
    } catch (e) {
      if (mine !== token || seq !== requestSequence) return;
      error(e.status === 401 ? 'Your session ended. Sign in to continue.' : 'Could not refresh your conversation. Close and reopen wekup to retry.');
      if (e.status === 401 || e.status === 403) { await S.refreshMe(); return; }
    }
    if (mine === token) schedule();
  }
  function configureContext(findingId = '_report') {
    saveDraft(); stopPoll(); ++token; ++requestSequence; posting = false; retry = null;
    const current = visibleReport();
    const fid = current?.findings?.some(f => f.id === findingId) ? findingId : '_report';
    context = { reportId: current?.id || null, findingId: fid, key: `${S.user?.id || 'anonymous'}:${current?.id || 'intro'}:${fid}` };
    retry = pendingRequests.get(context.key) || null;
    dialog.dataset.mode = context.reportId ? 'conversation' : 'intro';
    state = null; renderedMessages = ''; messages.innerHTML = ''; $('.wekup-current').innerHTML = ''; error();
    input.value = drafts.get(context.key) || '';
    $('.wekup-context').hidden = !current?.id;
    select.innerHTML = '<option value="_report">Whole checkup</option>' + (current?.findings || []).map(f => `<option value="${esc(f.id)}">${esc(f.title)}</option>`).join('');
    select.value = fid;
    const intro = $('.wekup-intro');
    intro.innerHTML = current?.id
      ? `<p class="wekup-kicker">LET'S LOOK AT THE EVIDENCE</p><h3>What looks different to you?</h3><p>Ask about ${esc(fid === '_report' ? 'this checkup' : 'this finding')}, tell me what I missed, or challenge my conclusion.</p><div class="wekup-suggestions"><button type="button" data-prompt="What evidence supports this finding?">Show me the evidence</button><button type="button" data-prompt="This works for me. Please check your finding again.">This works for me</button><button type="button" data-prompt="Could this be a limitation of your checker?">Could the checker be wrong?</button></div>`
      : `<p class="wekup-kicker">A FEATURE OF SUTROS</p><h3>A second look for your website.</h3><p>I'm wekup. I check public websites and help you question the findings. Open a saved checkup to have a private conversation about its evidence.</p><div class="wekup-welcome-actions"><button type="button" class="btn btn-primary" data-start-check>Check a website</button><a href="/account" data-spa>Find my checkups</a></div>`;
    $('.wekup-composer').hidden = !eligible();
    const gate = $('.wekup-gate');
    gate.innerHTML = !context.reportId ? '' : !S.user
      ? '<p>Your conversation stays private to your account.</p><button type="button" class="btn btn-primary" data-signin>Sign in to talk</button>'
      : !S.user.emailVerified ? '<p>Confirm your email to talk with wekup. Check your inbox for the confirmation link.</p>' : '';
    gate.hidden = !gate.innerHTML;
    paint();
  }
  async function open(findingId, trigger) {
    await S.ready;
    await S.refreshMe();
    returnFocus = trigger || document.activeElement || launcher;
    configureContext(findingId);
    if (!dialog.open) dialog.show();
    launcher.setAttribute('aria-expanded', 'true');
    if (eligible()) input.focus(); else $('.wekup-close').focus();
    loadConversation();
  }
  function close() {
    saveDraft(); stopPoll(); ++token; ++requestSequence;
    dialog.close(); launcher.setAttribute('aria-expanded', 'false');
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  async function send(event) {
    event.preventDefault();
    if (!eligible() || busy()) return;
    const message = input.value.trim();
    if (!message || message.length > 1600) return;
    const beforeRefresh = token;
    posting = true; paint();
    await S.refreshMe();
    if (beforeRefresh !== token) return;
    posting = false;
    if (!eligible() || busy()) { paint(); return; }
    const mine = token;
    const request = retry?.message === message && retry?.key === context.key ? retry : { requestId: crypto.randomUUID(), message, key: context.key, findingId: context.findingId };
    retry = request; pendingRequests.set(context.key, request); posting = true; ++requestSequence; stopPoll(); error(); paint();
    try {
      const data = await S.api(path(), { method: 'POST', expectedAccount: accountId, body: { findingId: request.findingId, message, requestId: request.requestId } });
      pendingRequests.delete(request.key);
      if (drafts.get(request.key)?.trim() === message) drafts.delete(request.key);
      if (mine !== token) return;
      posting = false; retry = null; ++requestSequence;
      if (input.value.trim() === message) input.value = '';
      saveDraft(); accept(data, mine); body.scrollTop = body.scrollHeight; schedule();
    } catch (e) {
      if (mine !== token) return;
      posting = false;
      error(e.message || 'Your message could not be sent. Try again; duplicate submissions will not run another check.');
      paint();
      if (e.status === 409) loadConversation();
      if (e.status === 401 || e.status === 403) await S.refreshMe();
    }
  }
  launcher.addEventListener('click', () => dialog.open ? close() : open('_report', launcher));
  $('.wekup-close').addEventListener('click', close);
  dialog.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  select.addEventListener('change', () => { const fid = select.value; configureContext(fid); loadConversation(); if (eligible()) input.focus(); });
  input.addEventListener('input', () => { saveDraft(); paint(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e); } });
  $('.wekup-composer').addEventListener('submit', send);
  host.addEventListener('click', e => {
    const prompt = e.target.closest('[data-prompt]');
    if (prompt && eligible()) { input.value = prompt.dataset.prompt; saveDraft(); paint(); input.focus(); }
    if (e.target.closest('[data-signin]')) { const next = '/r/' + context.reportId + '?wekup=' + encodeURIComponent(context.findingId); close(); S.requireLogin(next); }
    if (e.target.closest('[data-start-check]')) { close(); window.go?.('home'); document.getElementById('urlInput')?.focus(); document.getElementById('checkForm')?.scrollIntoView({ block: 'center' }); }
    if (e.target.closest('a[data-spa]')) close();
  });
  document.addEventListener('click', e => {
    const button = e.target.closest('[data-wekup-finding], [data-wekup-open]');
    if (button) open(button.dataset.wekupFinding || '_report', button);
    if (e.target.closest('[data-community-helpers]')) window.openHelpers?.();
  });
  function mountReport(r) {
    report = r; ++reportVersion; assessments.clear();
    if (dialog.open) close();
    document.querySelectorAll('.wekup-report-tools, .wekup-finding-tools').forEach(el => el.remove());
    if (!r?.id) return;
    const overview = document.createElement('section');
    overview.className = 'wekup-report-tools';
    overview.innerHTML = `<div><p class="wekup-kicker">QUESTION THE CHECKUP</p><h2>Talk it through with wekup.</h2><p>Something looks wrong? Share what you see and ask for another check.</p><p id="wekupReportStatus" class="wekup-limit">New assessments appear beside the original findings.</p></div><button type="button" class="btn btn-primary" data-wekup-finding="_report">Talk about this checkup</button><div class="wekup-assessment" data-finding="_report" hidden></div>`;
    document.getElementById('findingsRoot')?.prepend(overview);
    document.querySelectorAll('.f-slot[data-finding]').forEach(slot => {
      const block = document.createElement('div'); block.className = 'wekup-finding-tools';
      block.innerHTML = `<div class="wekup-assessment" data-finding="${esc(slot.dataset.finding)}" aria-live="polite" hidden></div><button type="button" class="wekup-discuss" data-wekup-finding="${esc(slot.dataset.finding)}">${icon}<span>Discuss with wekup</span>${arrow}</button>`;
      slot.before(block);
    });
    loadPublic();
  }
  const prior = S.onReportRendered;
  S.onReportRendered = function (r) { prior?.(r); mountReport(r); };
  if (S.report) mountReport(S.report);
  S.onUser(user => {
    const changed = (user?.id || null) !== accountId || Boolean(user?.emailVerified) !== accountVerified;
    if (!changed) return;
    if ((user?.id || null) !== accountId) {
      ++token; ++requestSequence; stopPoll(); drafts.clear(); pendingRequests.clear(); input.value = ''; state = null; renderedMessages = ''; messages.innerHTML = ''; $('.wekup-current').innerHTML = ''; retry = null; posting = false;
      accountId = user?.id || null;
      // Prevent configureContext from preserving the previous account's draft.
      context = null;
    }
    accountVerified = Boolean(user?.emailVerified);
    if (dialog.open) { const fid = select.value; configureContext(fid); loadConversation(); }
  });
  document.addEventListener('sutros:screen', e => {
    if (e.detail.id !== 'screen-report' && dialog.open) close();
    if (e.detail.id === 'screen-report') {
      const fid = new URLSearchParams(location.search).get('wekup');
      if (fid && report?.id) open(fid, launcher);
    }
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { stopPoll(); return; }
    if (dialog.open) { await S.refreshMe(); loadConversation(); loadPublic(); }
  });
  S.wekup = { open: findingId => open(findingId, launcher) };
})();
