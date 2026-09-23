// A browser load event does not mean an application has replaced its loading shell.
// This observes the current document only. It makes no requests and never navigates.
export async function waitForPageReady(page, {
  budgetMs = 7000, remainingMs = Infinity, requestedUrl = page.url(),
  navigationStartedAt = null, isBlocked = () => null,
} = {}) {
  const started = Date.now();
  const budget = Math.max(0, Math.min(7000, Number(budgetMs) || 0, Number(remainingMs)));
  const deadline = started + budget;
  const result = (status, reason) => ({
    page: page.url(), requestedUrl, status,
    elapsedMs: Math.max(0, Date.now() - (navigationStartedAt ?? started)),
    budgetMs: budget, reason, observedAt: new Date().toISOString(),
  });
  let last = null;
  do {
    const blocked = isBlocked();
    if (blocked) return result('blocked', String(blocked.reason || blocked).slice(0, 500));
    try {
      last = await bounded(page.evaluate(loadingState), Math.max(1, Math.min(1000, deadline - Date.now())));
    } catch {
      if (Date.now() >= deadline || page.isClosed()) return result('unreadable', 'The page contents could not be read within the render wait.');
      last = { loading: true, reason: 'The document was changing while it was read.' };
    }
    if (!last.loading) return result('ready', 'The observed page no longer showed a loading screen.');
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(150, left)));
  } while (Date.now() < deadline);
  return result('timed-out', `A loading screen was still present after the render wait. ${last?.reason || ''}`.trim());
}

async function bounded(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Render observation timed out.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// Runs in the page. Loading needs a visible signal, not merely a small amount of
// text. A logo, canvas, sparse page, or permanently authored "coming soon" text
// is not by itself evidence of a still-running application.
function loadingState() {
  const body = document.body;
  if (!body) return { loading: true, reason: 'The document body has not arrived.' };
  const visible = element => {
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < innerHeight && r.left < innerWidth && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const text = (body.innerText || '').replace(/\s+/g, ' ').trim();
  const short = text.length < 250;
  const prominent = element => {
    const r = element.getBoundingClientRect();
    return short || Math.min(r.width, innerWidth) * Math.min(r.height, innerHeight) >= innerWidth * innerHeight * 0.2;
  };
  const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].slice(0, 100)
    .some(element => visible(element) && prominent(element));
  if (busy) return { loading: true, reason: 'A visible busy or progress indicator is present.' };
  const skeleton = [...document.querySelectorAll('[class*="skeleton" i], [class*="shimmer" i], [class*="loading-placeholder" i]')].slice(0, 100)
    .some(element => visible(element) && prominent(element));
  if (skeleton) return { loading: true, reason: 'A visible skeleton placeholder is present.' };
  if (short && /^(?:loading(?:\s+(?:page|content|application|app|data))?|please\s+wait|initializing|just\s+a\s+moment)(?:[.!…\s]*)$/i.test(text)) {
    return { loading: true, reason: 'The visible page consists of a loading message.' };
  }
  const root = document.querySelector('#root, #app, #__next, [data-reactroot]');
  if (root && !text && !root.querySelector('img, svg, canvas, video, iframe, input, button, a[href]')) {
    return { loading: true, reason: 'The application root is still empty.' };
  }
  return { loading: false, reason: '' };
}
