// Fixed verification lessons learned from reader feedback. Every sentence a
// future checkup can receive comes from this catalog: feedback and model output
// only ever select an id, never write text. Lessons guide how to verify; they
// never establish that a website has or lacks a problem.
const lesson = (category, text) => Object.freeze({ category, text });

export const LESSON_CATALOG = Object.freeze({
  'availability-recheck-twice': lesson('availability', 'Before reporting an address as broken, confirm the same HTTP error on two separate requests and record both answers.'),
  'availability-transport-not-broken': lesson('availability', 'A connection that fails without an HTTP answer is a coverage gap, not a broken address. Record it as inconclusive with its reason.'),
  'availability-changed-since': lesson('availability', 'Addresses can answer differently between checkups. Record the time and exact answer of every availability observation and do not assume an earlier answer still holds.'),
  'availability-blocked-not-broken': lesson('availability', 'An access refusal, rate limit, or bot check is not a broken address. Record what answered and mark the address not measured.'),
  'rendering-wait-for-styles': lesson('rendering', 'Before noting a layout or missing-style problem, wait for stylesheets to finish loading and confirm the render was reliable.'),
  'rendering-bot-check': lesson('rendering', 'A page that answers with a bot check or interstitial is not a rendering problem. Treat it as not measured.'),
  'rendering-real-device-differs': lesson('rendering', 'A render that looks broken to the checker may look fine on real devices. Keep mobile render notes to what a reliable render actually showed and mark unreliable renders not measured.'),
  'interaction-closable-overlay': lesson('interaction', 'When a banner, cookie notice, or chat window appears, test whether it can be dismissed and whether it prevents the intended task. Note it only when it blocks the task or cannot be closed.'),
  'interaction-confirm-in-page': lesson('interaction', 'Only note an interaction problem after attempting the interaction on the page in front of you and recording what happened.'),
  'evidence-quote-page-text': lesson('evidence', 'Support each note with a direct quote or measurement from the page, or with an inference that is labeled as an inference and tied to what was observed.'),
  'evidence-picture-when-visual': lesson('evidence', 'For a visual claim, keep the picture that shows it. Without one, mark the note as unverified.'),
  'context-intentional-design': lesson('context', 'A dated look or unusual layout may be intentional. Describe what you see without judging whether it is a mistake.'),
  'context-expected-behaviour': lesson('context', 'Behaviour that looks like a problem may be intended by the site owner. Describe behaviour neutrally and let the reader decide.'),
  'context-gated-content': lesson('context', 'Pages behind a login, payment, or age gate cannot be judged from outside. Mark them not measured.'),
  'context-headers-common': lesson('context', 'Missing security headers are common on healthy sites. Assess what protection each header would add in the context of the site and record the evidence, rather than assuming harm.'),
  'method-agreement-keep': lesson('method', 'Readers agreed with findings of this kind, which is unverified. Verify the next finding of this kind independently, using the same method and recording the same evidence.'),
  'method-disputed-reverify': lesson('method', 'Findings of this kind cannot be rechecked automatically afterwards. Re-verify them with direct evidence before reporting them.'),
  'method-report-disputed': lesson('method', 'Tie every finding to recorded evidence and name what was not measured, so the report can be checked as a whole.'),
});

export const LESSON_SCOPES = Object.freeze(['site', 'general']);
export const MAX_GUIDANCE = 8;
const MAX_TEXT = 240;
const SCOPE_LABEL = { site: 'this site', general: 'all sites' };

// Keep only catalog ids with a known scope, site before general, one line per id.
function canonical(lessons) {
  const seen = new Map();
  for (const entry of Array.isArray(lessons) ? lessons : []) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    const scope = typeof entry?.scope === 'string' ? entry.scope : null;
    if (!id || !Object.hasOwn(LESSON_CATALOG, id) || !LESSON_SCOPES.includes(scope)) continue;
    const previous = seen.get(id);
    if (!previous || (previous.scope === 'general' && scope === 'site')) seen.set(id, { id, scope, text: LESSON_CATALOG[id].text.slice(0, MAX_TEXT) });
  }
  return [...seen.values()].sort((a, b) => LESSON_SCOPES.indexOf(a.scope) - LESSON_SCOPES.indexOf(b.scope)).slice(0, MAX_GUIDANCE);
}

export function publicGuidance(lessons) { return canonical(lessons); }

export function formatFeedbackGuidance(lessons) {
  const items = canonical(lessons);
  if (!items.length) return '';
  return ['Verification guidance learned from reader feedback. These are reminders about how to check, not facts about this website:',
    ...items.map((item) => `- (${SCOPE_LABEL[item.scope]}) ${item.text}`)].join('\n');
}
