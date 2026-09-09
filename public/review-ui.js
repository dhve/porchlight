(function () {
  const S = window.Sutros;
  if (!S) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
  let request = 0;
  const screen = document.createElement('div');
  screen.id = 'screen-review'; screen.className = 'screen';
  document.querySelector('#screens-extra').append(screen);
  const link = document.createElement('a');
  link.href = '/review'; link.textContent = 'Review feedback'; link.hidden = true;
  document.querySelector('footer .disc').append(' · ', link);
  link.addEventListener('click', event => { event.preventDefault(); S.navigate('/review'); });

  function frame(body) {
    screen.innerHTML = `<section class="report"><div class="wrap"><p class="eyebrow">Feedback review</p><h1>Check the evidence</h1><p class="review-intro">Reader responses are unverified. Review the recorded evidence and explain your decision. Each review is kept separately from the original signed report.</p>${body}</div></section>`;
  }
  function card(item, index) {
    const finding = item.finding;
    const review = item.review;
    const notes = (item.notes || []).map(n => `<li>${esc(n.text)}<small>${esc(n.submittedAt || '')}</small></li>`).join('');
    const reason = review ? `<p class="review-latest"><b>Latest review: ${esc(review.status)}.</b> ${esc(review.reason)}</p>` : '';
    const form = finding && item.reviewable !== false ? `<form class="review-form" data-index="${index}"><label for="reviewStatus${index}">Decision</label><select id="reviewStatus${index}" name="status" required><option value="">Select a decision</option><option value="confirmed">Confirmed by the evidence</option><option value="incorrect">Incorrect finding</option><option value="inconclusive">Cannot confirm</option></select><label for="reviewReason${index}">Public explanation of the evidence</label><textarea id="reviewReason${index}" name="reason" rows="3" minlength="20" maxlength="2000" required></textarea><p class="fb-policy">This explanation will be public. Do not copy private notes or personal details into it. State the observations that support the decision and any limits.</p><button class="btn btn-primary" type="submit">Publish this review</button><p class="review-error" role="status"></p></form>` : '<p>Overall report feedback helps prioritize investigation. Review decisions and evaluation labels apply to individual findings.</p>';
    return `<article class="review-case"><h2>${esc(finding?.title || 'Overall checkup feedback')}</h2><p><a href="/r/${encodeURIComponent(item.reportId)}" target="_blank" rel="noopener">Open original report</a> · ${esc(item.findingId)}</p><p>${count(item.counts?.right)} responses say right; ${count(item.counts?.wrong)} say wrong.</p>${reason}<details><summary>Recorded finding and evidence</summary><pre>${esc(JSON.stringify(finding || item.report, null, 2))}</pre></details><details><summary>Private notes (${count(item.notes?.length)})</summary>${notes ? `<ul class="review-notes">${notes}</ul>` : '<p>No private notes.</p>'}</details>${form}</article>`;
  }
  async function loadReview(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    const token = ++request;
    S.showScreen('screen-review');
    frame('<p role="status">Loading review access…</p>');
    await S.ready;
    if (token !== request) return;
    if (S.user?.role !== 'admin') {
      frame('<p>This screen is available to authorized reviewers.</p><p><a href="/login?next=%2Freview">Sign in</a> or <a href="/">return to the checkup</a>.</p>');
      return;
    }
    try {
      const data = await S.api(`/api/feedback/review-queue?limit=50&offset=${offset}`);
      if (token !== request || S.user?.role !== 'admin') return;
      const cases = Array.isArray(data.cases) ? data.cases : [];
      const pagination = data.pagination || {limit:50,offset,hasMore:false};
      frame(`<div class="review-actions"><button type="button" class="btn btn-ghost" id="exportCases">Download reviewed test cases</button><button type="button" class="btn btn-ghost" id="refreshReviews">Refresh</button><p id="reviewStatus" role="status"></p></div>${cases.length ? cases.map(card).join('') : '<p>No cases on this page.</p>'}<div class="review-actions" aria-label="Review queue pages">${offset > 0 ? '<button type="button" class="btn btn-ghost" id="previousReviews">Previous cases</button>' : ''}${pagination.hasMore ? '<button type="button" class="btn btn-ghost" id="nextReviews">Next cases</button>' : ''}</div>`);
      screen.querySelector('#refreshReviews').addEventListener('click', () => loadReview(offset));
      screen.querySelector('#previousReviews')?.addEventListener('click', () => loadReview(Math.max(0, offset - 50)));
      screen.querySelector('#nextReviews')?.addEventListener('click', () => loadReview(offset + 50));
      screen.querySelector('#exportCases').addEventListener('click', exportCases);
      screen.querySelectorAll('.review-form').forEach(form => form.addEventListener('submit', async event => {
        event.preventDefault();
        const item = cases[Number(form.dataset.index)];
        const button = form.querySelector('button');
        const status = form.querySelector('.review-error');
        button.disabled = true; status.textContent = 'Saving review…';
        try {
          await S.api(`/api/reports/${encodeURIComponent(item.reportId)}/feedback/review`, {method:'POST',body:{findingId:item.findingId,status:form.elements.status.value,reason:form.elements.reason.value.trim()}});
          if (token !== request) return;
          status.textContent = 'Review published. The original report is unchanged.';
          button.textContent = 'Review published';
          form.querySelectorAll('select,textarea').forEach(el => el.disabled = true);
          loadProgress();
        } catch (error) { button.disabled = false; status.textContent = error.message || 'The review could not be saved.'; }
      }));
    } catch (error) { if (token === request) frame(`<p role="alert">${esc(error.message || 'The review queue could not be loaded.')}</p>`); }
  }
  async function exportCases(event) {
    const token = request;
    const button = event.currentTarget, status = screen.querySelector('#reviewStatus');
    button.disabled = true; status.textContent = 'Preparing reviewed cases…';
    try {
      const data = await S.api('/api/feedback/evaluation-cases');
      if (token !== request || S.user?.role !== 'admin') return;
      const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'sutros-reviewed-cases.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `Exported ${count(data.cases?.length)} reviewed cases. These selected cases do not measure accuracy across all websites.`;
    } catch (error) { status.textContent = error.message || 'The export could not be prepared.'; }
    finally { button.disabled = false; }
  }
  async function loadProgress() {
    const box = document.querySelector('#feedbackProgress');
    if (!box) return;
    try {
      const data = await S.api('/api/feedback/progress');
      const automatic = data.automatic;
      box.innerHTML = `<p>${count(data.signals?.total)} feedback responses received.</p>${automatic?.mode === 'automatic' ? `<p>${count(automatic.processed)} of ${count(automatic.submitted)} feedback cases processed automatically. ${count(automatic.pending)} pending; ${count(automatic.failed)} could not finish. ${count(automatic.lessonsActive)} active verification lessons.</p>` : '<p>Automatic processing totals are unavailable right now.</p>'}<p class="fb-policy">${esc(data.limitation || 'Feedback guides later checkups. These totals do not measure overall accuracy.')}</p>`;
    } catch { box.textContent = 'Feedback totals are unavailable right now.'; }
  }
  S.route(/^\/review\/?$/, () => loadReview());
  S.onUser(user => {
    link.hidden = user?.role !== 'admin';
    if (user?.role !== 'admin') { ++request; screen.innerHTML = ''; }
    if (location.pathname.replace(/\/$/, '') === '/review') loadReview();
  });
  S.ready.then(() => { link.hidden = S.user?.role !== 'admin'; loadProgress(); });
})();
