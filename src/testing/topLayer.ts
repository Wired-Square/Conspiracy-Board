import { startDialogEscape } from '../platform/dialogEscape';

// jsdom has no top layer: no showModal and no popover. Escape is the app's own, as
// in the webview.
if (typeof HTMLDialogElement !== 'undefined') {
  startDialogEscape();

  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  const shown = new Set<HTMLElement>();
  const toggle = (panel: HTMLElement, newState: 'open' | 'closed') => {
    if (!panel.dispatchEvent(Object.assign(new Event('beforetoggle', { cancelable: true }), { newState }))) return;
    if (newState === 'open') shown.add(panel);
    else shown.delete(panel);
    panel.style.display = newState === 'open' ? 'block' : '';
    panel.dispatchEvent(Object.assign(new Event('toggle'), { newState }));
  };
  HTMLElement.prototype.showPopover = function () {
    if (!shown.has(this)) toggle(this, 'open');
  };
  HTMLElement.prototype.hidePopover = function () {
    if (shown.has(this)) toggle(this, 'closed');
  };
  document.addEventListener('click', (e) => {
    const id = (e.target as Element).closest('[popovertarget]')?.getAttribute('popovertarget');
    const panel = id && document.getElementById(id);
    if (panel) toggle(panel, shown.has(panel) ? 'closed' : 'open');
  });
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Element;
    for (const panel of shown) {
      const invoker = target.closest?.('[popovertarget]')?.getAttribute('popovertarget') === panel.id;
      if (panel.getAttribute('popover') === 'auto' && !panel.contains(target) && !invoker) toggle(panel, 'closed');
    }
  });
}
