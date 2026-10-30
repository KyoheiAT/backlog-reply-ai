(function (global) {
  'use strict';
  function attach(root, editor) {
    let disposed = false;
    let dock = null;
    let scrollArea = null;
    let spacer = null;
    let reserved = 0;
    let collapsedHeight = 42;
    const document = root.ownerDocument;
    const window = document.defaultView;
    const style = element => window.getComputedStyle(element);
    const rootScroller = () => document.scrollingElement || document.documentElement;
    function clearSpace() {
      spacer?.remove();
      spacer = null;
      scrollArea = null;
      reserved = 0;
    }
    function findDock() {
      for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
        const css = style(node);
        const rect = node.getBoundingClientRect();
        if (['fixed', 'sticky'].includes(css.position) && rect.top > 0 && rect.bottom >= window.innerHeight - 80) return node;
      }
      return null;
    }
    function findScrollArea(rect) {
      // The comment list may scroll inside the app rather than the document.
      // Inspect the visible area immediately above the dock, never editor internals.
      const x = Math.max(1, Math.min(window.innerWidth - 2, rect.left + rect.width / 2));
      const y = Math.max(1, rect.top - 2);
      for (const hit of document.elementsFromPoint(x, y)) {
        if (root.contains(hit) || dock.contains(hit)) continue;
        for (let node = hit; node && node !== document.body; node = node.parentElement) {
          if (node.clientHeight > 80 && /^(auto|scroll|overlay)$/.test(style(node).overflowY)) return node;
        }
      }
      return rootScroller();
    }
    function update() {
      if (disposed) return;
      if (!root.isConnected || !editor.isConnected) {clearSpace(); root.classList.remove('bcr-docked'); return;}
      const nextDock = findDock();
      if (dock !== nextDock) {
        if (dock) resize?.unobserve(dock);
        clearSpace();
        dock = nextDock;
        if (dock) resize?.observe(dock);
      }
      root.classList.toggle('bcr-docked', !!dock);
      if (!dock) {clearSpace(); return;}
      const collapsed = root.classList.contains('bcr-collapsed');
      const css = style(root);
      const height = root.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
      if (collapsed) collapsedHeight = height;
      const needed = collapsed ? 0 : Math.max(0, Math.ceil(height - collapsedHeight));
      if (!needed) {clearSpace(); return;}
      const nextArea = findScrollArea(dock.getBoundingClientRect());
      if (nextArea !== scrollArea || !spacer?.isConnected) {
        clearSpace();
        scrollArea = nextArea;
        spacer = document.createElement('div');
        spacer.className = 'bcr-comment-clearance';
        spacer.setAttribute('aria-hidden', 'true');
        (scrollArea === rootScroller() ? document.body : scrollArea).appendChild(spacer);
      }
      if (reserved === needed) return;
      const atBottom = scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop <= 24;
      spacer.style.height = `${needed}px`;
      reserved = needed;
      // Keep a reader who was at the end at the end, now above the taller dock.
      // Readers inspecting an older comment retain their scroll position.
      if (atBottom) scrollArea.scrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
    }
    const resize = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(update) : null;
    resize?.observe(root);
    window.addEventListener('resize', update);
    update();
    return {update, destroy() {
      disposed = true;
      resize?.disconnect();
      window.removeEventListener('resize', update);
      clearSpace();
      root.classList.remove('bcr-docked');
    }};
  }
  global.BacklogPanelLayout = Object.freeze({attach});
})(globalThis);
