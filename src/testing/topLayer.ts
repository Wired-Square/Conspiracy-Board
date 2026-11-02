// jsdom has no top layer: no showModal, no popover, and no Escape cancelling the top modal.
if (typeof HTMLDialogElement !== 'undefined') {
  const modals: HTMLDialogElement[] = [];
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    if (!modals.includes(this)) modals.push(this);
  };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    if (modals.includes(this)) modals.splice(modals.indexOf(this), 1);
    this.dispatchEvent(new Event('close'));
  };

  // The platform's default action for Escape, after every listener has had the chance to prevent it.
  // jsdom's window has an EventTarget of its own, apart from the global one nodes use.
  const owner = (o: object): EventTarget => (Object.hasOwn(o, 'dispatchEvent') ? (o as EventTarget) : owner(Object.getPrototypeOf(o)));
  for (const proto of new Set([EventTarget.prototype, owner(window)])) {
    const dispatch = proto.dispatchEvent;
    proto.dispatchEvent = function (event) {
      const result = dispatch.call(this, event);
      if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Escape' && !event.defaultPrevented) {
        const top = modals.filter((d) => d.open && d.isConnected).at(-1);
        if (top?.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
      }
      return result;
    };
  }

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
