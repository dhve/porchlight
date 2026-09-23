(function (root) {
  function assessment(report = {}) {
    const networkLimited = (Array.isArray(report.findings) ? report.findings : []).some(connectionLimitation);
    const incomplete = networkLimited || report.assessment?.status === 'incomplete' || report.grade === '?' || report.score === null;
    const headline = networkLimited ? 'This report needs verification' : incomplete ? 'This checkup is incomplete' : ({
      'A+': 'No issues found in these checks', A: 'No major issues found in these checks', B: 'A few issues need a look',
      C: 'These checks found issues to address', D: 'These checks found serious issues',
      F: 'These checks found urgent issues',
    }[report.grade] || 'Website checkup results');
    const reason = networkLimited
      ? 'Some saved findings counted requests with no HTTP response as confirmed website problems. The original grade therefore needs verification. The recorded evidence and original explanations remain available below.'
      : report.assessment?.reason || (incomplete ? 'Some observations could not be completed. The results below are partial.' : '');
    return { incomplete, headline, reason, networkLimited };
  }
  function recheckState(item = {}) {
    if (!['working', 'broken'].includes(item.classification)) {
      const details = {
        timeout: 'The request timed out before the checker could confirm the result.',
        dns: 'The checker could not look up the website address from its network.',
        refused: 'The connection was refused before an HTTP response arrived.',
        reset: 'The connection closed before the checker could confirm the result.',
        challenge: 'The response asked the checker to pass an access check.',
        'response-read-failed': 'The checker received a response but could not finish reading it.',
        'access-or-service-refusal': 'The response may reflect an access restriction or a temporary service limit.',
        'not-allowed': 'The address was not requested because it did not pass the public-address check.',
        'invalid-redirect': 'The response did not provide a usable address to follow.',
        'redirect-loop': 'The response sent the checker through a repeating chain of addresses.',
        'redirect-limit': 'The checker reached its limit for following redirected addresses.',
        'unknown-baseline': 'The original check did not establish a result that can be compared with this request.',
      };
      return { classification: 'inconclusive', label: 'Could not confirm', detail: details[item.reason] || 'This request could not establish whether the address works or whether it changed.' };
    }
    const working = item.classification === 'working';
    return {
      classification: item.classification,
      label: working ? 'Address loaded' : 'This request received an error',
      detail: item.changed === true ? 'The availability result changed since the original check.' : item.changed === false ? 'The availability result is unchanged.' : 'This does not establish a change from the original check.',
    };
  }
  function evidenceItems(finding) {
    return Array.isArray(finding?.evidence?.items) ? finding.evidence.items : [];
  }
  function retestSupported(finding = {}) {
    if (!finding) return false;
    if (finding.source === 'agent' || String(finding.id).startsWith('agent-')) return false;
    if (!/^(broken-links|broken-images|flow-(error|missing)-.+)$/.test(String(finding.id))) return false;
    return evidenceItems(finding).some(item => {
      try { return /^https?:$/.test(new URL(item.url).protocol); } catch { return false; }
    });
  }
  function connectionLimitation(finding = {}) {
    if (!retestSupported(finding)) return null;
    const failures = evidenceItems(finding).filter(item => item && item.status === 0);
    if (!failures.length) return null;
    const title = finding.id === 'broken-images' ? 'Image connections need verification'
      : finding.id === 'broken-links' ? 'Link connections need verification' : 'The page connection needs verification';
    return { title, count: failures.length,
      message: `Sutros recorded no HTTP response for ${failures.length} address${failures.length === 1 ? '' : 'es'}. A failed connection can reflect network conditions or access restrictions. It does not establish an HTTP error or show whether other visitors could load the page.` };
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const link = value => {
    try {
      const url = new URL(value);
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(value)}</a>`;
    } catch {}
    return escape(value || 'Not recorded');
  };
  const count = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  function reviewCard(report = {}) {
    const review = report.engine?.proof?.review;
    const screening = report.engine?.proof?.contentScreening;
    if (!review && !screening) return '';
    const label = review?.status === 'completed' ? 'Final evidence review completed' : 'Final evidence review could not finish';
    return `<details class="coverage-card final-proof-review"><summary>${label}</summary>${review ? `<p>${escape(review.summary)}</p><p>${count(review.counts?.supported)} supported observations; ${count(review.counts?.needsVerification)} need further verification.</p><p>This AI review checks the recorded evidence. It does not guarantee correctness or replace testing the website yourself.</p>` : ''}${screening ? `<p>${escape(screening.summary)} ${escape(screening.scope)}</p>` : ''}</details>`;
  }
  function findingReview(finding = {}) {
    const review = finding.proofReview;
    if (!review) return '';
    const supported = review.status === 'supported';
    return `<p class="observation-source proof-review-status"><b>${supported ? 'Supported by the recorded evidence.' : 'Needs further verification. Not used to calculate the grade.'}</b> ${escape(review.reason)}</p>`;
  }
  function pageLoadsCard(report = {}) {
    const loads = [
      ...(Array.isArray(report.engine?.browser?.pageLoads) ? report.engine.browser.pageLoads.map(item => ({...item,check:'Browser'})) : []),
      ...(Array.isArray(report.agent?.pageLoads) ? report.agent.pageLoads.map(item => ({...item,check:'AI browsing'})) : []),
    ].slice(0, 80);
    if (!loads.length) return '';
    const rows = loads.map(load => {
      const seconds = Number.isFinite(load.elapsedMs) ? (Math.max(0, load.elapsedMs) / 1000).toFixed(1) : null;
      const label = load.status === 'ready' ? `Ready${seconds ? ` after ${seconds} seconds` : ''}` : load.status === 'timed-out' ? `Still loading${seconds ? ` after ${seconds} seconds` : ''}` : 'Could not confirm loading';
      return `<li><span>${escape(load.check)}: ${link(load.page || load.requestedUrl)}</span><b>${escape(label)}</b>${load.reason ? `<p>${escape(load.reason)}</p>` : ''}</li>`;
    }).join('');
    return `<details class="coverage-card page-loads"><summary>Observed page loading times</summary><p>After navigation, loading screens receive up to a 7-second additional wait. Elapsed times include navigation and observation on the checker. Your device and connection may differ.</p><ul class="coverage-list">${rows}</ul></details>`;
  }
  function runtimeLocations(finding = {}) {
    const errors = Array.isArray(finding.evidence?.runtimeErrors) ? finding.evidence.runtimeErrors : [];
    if (!errors.length) return '';
    const rows = errors.slice(0, 50).map(error => {
      const source = error.source;
      const line = Number.isInteger(source?.line) && source.line > 0 ? source.line : null;
      const column = Number.isInteger(source?.column) && source.column > 0 ? source.column : null;
      const location = source?.url ? `${link(source.url)}${line ? `; line ${line}` : ''}${column ? `, column ${column}` : ''}` : 'The browser did not provide a script file and line.';
      return `<li class="runtime-location"><p><b>Page:</b> ${link(error.page)}</p>${error.frameUrl && error.frameUrl !== error.page ? `<p><b>Frame:</b> ${link(error.frameUrl)}</p>` : ''}<p><b>Reported script:</b> ${location}</p><pre>${escape(error.message)}</pre>${error.hydration ? '<p>React can recover from a hydration mismatch by rendering again. This message alone does not establish a visible failure.</p>' : ''}${error.domLocation || error.html ? `<p><b>Recorded HTML location:</b> ${escape(error.domLocation || 'Selector not recorded')}</p>${error.html ? `<pre>${escape(error.html)}</pre>` : ''}` : '<p>The affected HTML element was not identified. The recorded script may be a compiled bundle; an original source file requires the site owner’s source maps or development tools.</p>'}${error.stack ? `<details><summary>Recorded stack trace</summary><pre>${escape(error.stack)}</pre></details>` : ''}</li>`;
    }).join('');
    return `<div class="runtime-locations"><p class="proof-k">Where the script error was recorded</p><p>A runtime error does not establish that a button, menu, or form failed. Check the visitor action on the recorded page to confirm its effect.</p><ul class="proof-addresses">${rows}</ul></div>`;
  }
  root.SutrosEvidence = { assessment, recheckState, retestSupported, connectionLimitation, reviewCard, findingReview, pageLoadsCard, runtimeLocations };
})(globalThis);
