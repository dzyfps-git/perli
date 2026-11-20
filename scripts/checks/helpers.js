// Drives the visible pane's file list through DOM and page events only: no real mouse or keys.
window.P = {
  grid: () => document.querySelector('.panes:not([hidden]) .pane.pane-active .file-grid') ?? document.querySelector('.panes:not([hidden]) .pane .file-grid'),
  rows: () => [...P.grid().querySelectorAll('.file-row')].filter((r) => !r.hasAttribute('data-empty')).sort((a, b) => Number(a.getAttribute('aria-rowindex')) - Number(b.getAttribute('aria-rowindex'))),
  rowName: (r) => r.querySelector('.file-label')?.textContent ?? r.querySelector('.file-name')?.textContent,
  names: () => P.rows().map(P.rowName),
  row: (name) => P.rows().find((r) => P.rowName(r) === name),
  mouse: (target, type, init = {}) => {
    const box = target.getBoundingClientRect();
    const at = { clientX: box.left + Math.min(40, box.width / 2), clientY: box.top + box.height / 2, bubbles: true, cancelable: true, view: window, ...init };
    const Kind = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Kind(type, type.startsWith('pointer') ? { pointerId: 1, isPrimary: true, ...at } : at));
  },
  label: (name) => { const r = P.row(name); if (!r) throw new Error('no row ' + name); return r.querySelector('.file-label') ?? r; },
  click: (name, init = {}) => {
    const t = P.label(name);
    P.mouse(t, 'pointerdown', init);
    P.mouse(t, 'mousedown', init);
    P.mouse(t, 'pointerup', init);
    P.mouse(t, 'mouseup', init);
    P.mouse(t, 'click', { detail: 1, ...init });
    P.grid().focus();
  },
  dbl: (name, init = {}) => {
    P.click(name, init);
    P.mouse(P.label(name), 'dblclick', { detail: 2, ...init });
  },
  key: (key, init = {}) => {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : P.grid();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  },
  wkey: (key, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })),
  type: (input, text) => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  },
  menu: (target) => {
    const el = typeof target === 'string' ? P.label(target) : target;
    P.mouse(el, 'contextmenu', { button: 2, buttons: 2 });
  },
  bgMenu: () => {
    const g = P.grid();
    const box = g.getBoundingClientRect();
    g.dispatchEvent(new MouseEvent('contextmenu', { button: 2, buttons: 2, clientX: box.left + 20, clientY: box.bottom - 10, bubbles: true, cancelable: true, view: window }));
  },
  menuItem: (label) => [...document.querySelectorAll('.menu .menu-item')].find((b) => b.querySelector('.menu-label')?.textContent.includes(label)),
  closeMenus: () => {
    for (let i = 0; i < 3 && document.querySelector('.menu'); i++) document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
  },
};
"ok";
