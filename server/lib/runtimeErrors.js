// Preserve recorded source locations separately from display text. No DOM element
// or visitor-visible failure can be inferred from an exception stack alone.
const MAX_ERRORS = 30;
const limit = (value, length) => String(value ?? '').slice(0, length);
const integer = value => Number.isInteger(value) && value >= 0 ? value + 1 : null;

export function collectRuntimeErrors(page) {
  const errors = [];
  const add = (kind, message, stack, source) => {
    if (errors.length >= MAX_ERRORS) return;
    errors.push({ kind, page: page.url(), frameUrl: null, observedAt: new Date().toISOString(),
      message: limit(message, 4000), stack: limit(stack, 12000), source,
      domLocation: null, html: null, impact: 'not-tested',
      hydration: /(?:Minified React error #(418|423)\b|hydration|hydrating|server.rendered HTML)/i.test(String(message)),
    });
  };
  page.on('pageerror', error => {
    const stack = String(error.stack || '');
    const frame = stack.split('\n').slice(1).map(line => line.match(/(https?:\/\/[^\s()]+):(\d+):(\d+)/)).find(Boolean);
    const source = frame ? {url:limit(frame[1],8192),line:Number(frame[2]) || null,column:Number(frame[3]) || null} : null;
    add('pageerror', error.message, stack, source);
  });
  page.on('console', message => {
    if (message.type() !== 'error' || /^Failed to load resource/i.test(message.text())) return;
    const where = message.location?.();
    const source = where?.url ? {url:limit(where.url,8192),line:integer(where.line ?? where.lineNumber),column:integer(where.column ?? where.columnNumber)} : null;
    add('console', message.text(), '', source);
  });
  return errors;
}

export function runtimeErrorLine(error) {
  const source = error.source;
  const location = source?.url ? `${source.url}${source.line == null ? '' : ':' + source.line}${source.column == null ? '' : ':' + source.column}` : 'source location unavailable';
  return `${error.message} (at ${location})`;
}
