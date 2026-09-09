(function (root) {
  function assessment(report = {}) {
    const networkLimited = (Array.isArray(report.findings) ? report.findings : []).some(connectionLimitation);
    const incomplete = networkLimited || report.assessment?.status === 'incomplete' || report.grade === '?' || report.score === null;
    const headline = networkLimited ? 'This report needs verification' : incomplete ? 'This checkup is incomplete' : ({
      A: 'No major issues found in these checks', B: 'A few issues need a look',
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
      return { classification: 'inconclusive', label: 'Could not confirm', detail: item.reason || 'This request could not establish whether the address works or whether it changed.' };
    }
    const working = item.classification === 'working';
    return {
      classification: item.classification,
      label: working ? 'Address loaded' : (item.changed === false ? 'Address still failed' : 'Address failed'),
      detail: item.changed === true ? 'The availability result changed since the original check.' : item.changed === false ? 'The availability result is unchanged.' : 'The original result is not comparable.',
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
  root.SutrosEvidence = { assessment, recheckState, retestSupported, connectionLimitation };
})(globalThis);
