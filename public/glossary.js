import { glossary, findGlossaryTerms } from './glossary-data.js';

const terms = new Map(glossary.map(t => [t.key, t]));
const skip = 'a,button,input,textarea,select,option,script,style,pre,code,svg,summary,dialog:not(#wekupDialog),[contenteditable],[data-no-glossary]';
const dialog = document.createElement('dialog');
dialog.className = 'definition-dialog';
dialog.setAttribute('aria-labelledby', 'definitionTitle');
dialog.setAttribute('aria-describedby', 'definitionText');
dialog.innerHTML = '<p class="eyebrow">In plain language</p><h2 id="definitionTitle"></h2><p id="definitionText"></p><button type="button" class="btn btn-primary">Close definition</button>';
document.body.append(dialog);
let opener;
dialog.querySelector('button').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const b = dialog.getBoundingClientRect();
  if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) dialog.close();
});
dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
document.addEventListener('click', event => {
  const button = event.target.closest?.('button[data-term-key]');
  const term = button && terms.get(button.dataset.termKey);
  if (!term) return;
  opener = button;
  dialog.querySelector('#definitionTitle').textContent = term.label;
  dialog.querySelector('#definitionText').textContent = term.definition;
  if (!dialog.open) dialog.showModal();
});

export function decorateTerms(root) {
  if (!root?.isConnected) return;
  const nodes = [];
  if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
  else {
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(skip)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    if (!node.parentElement || node.parentElement.closest(skip)) continue;
    const text = node.textContent;
    const matches = findGlossaryTerms(text);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(text.slice(offset, match.start));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'defined-term';
      button.dataset.termKey = match.key;
      button.textContent = text.slice(match.start, match.end);
      button.setAttribute('aria-label', `Define ${terms.get(match.key).label}`);
      button.setAttribute('aria-haspopup', 'dialog');
      fragment.append(button);
      offset = match.end;
    }
    fragment.append(text.slice(offset));
    node.replaceWith(fragment);
  }
}
decorateTerms(document.body);
const pending = new Set();
let scheduled = false;
const observer = new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'characterData') pending.add(record.target);
    else record.addedNodes.forEach(n => pending.add(n));
  }
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const roots = [...pending]; pending.clear();
    for (const root of roots) decorateTerms(root);
  });
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
