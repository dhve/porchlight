(function (root) {
  function assessment(report = {}) {
    const incomplete = report.assessment?.status === 'incomplete' || report.grade === '?' || report.score === null;
    const headline = incomplete ? 'This checkup is incomplete' : ({
      A: 'No major issues found in these checks', B: 'A few issues need a look',
      C: 'These checks found issues to address', D: 'These checks found serious issues',
      F: 'These checks found urgent issues',
    }[report.grade] || 'Website checkup results');
    return { incomplete, headline, reason: report.assessment?.reason || (incomplete ? 'Some observations could not be completed. The results below are partial.' : '') };
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
  function retestSupported(finding = {}) {
    if (finding.source === 'agent' || String(finding.id).startsWith('agent-')) return false;
    if (!/^(broken-links|broken-images|flow-(error|missing)-.+)$/.test(String(finding.id))) return false;
    return (finding.evidence?.items || []).some(item => {
      try { return /^https?:$/.test(new URL(item.url).protocol); } catch { return false; }
    });
  }
  root.SutrosEvidence = { assessment, recheckState, retestSupported };
})(globalThis);
