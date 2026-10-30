import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../panel-layout.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../content.css', import.meta.url), 'utf8');
function fixture({nested = false, fixed = true, atBottom = true} = {}) {
  const listeners = new Map();
  let observer;
  class Element {
    constructor() {
      this.parentElement = null; this.children = []; this.isConnected = true; this.style = {};
      this.css = {position: 'static', overflowY: 'visible', marginTop: '0', marginBottom: '0'};
      this.rect = {top: 0, bottom: 700, left: 0, width: 1000, height: 700};
      this.clientHeight = 700; this.baseHeight = 1400; this.scrollTop = 0;
      const classes = new Set();
      this.classList = {contains: name => classes.has(name), remove: name => classes.delete(name),
        toggle(name, enabled) {if (enabled) classes.add(name); else classes.delete(name);}};
    }
    get scrollHeight() {return this.baseHeight + this.children.reduce((sum, child) => sum + (parseFloat(child.style.height) || 0), 0);}
    appendChild(child) {this.children.push(child); child.parentElement = this; child.isConnected = true;}
    contains(other) {return other === this || this.children.some(child => child.contains(other));}
    remove() {if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.isConnected = false;}
    getBoundingClientRect() {return this.rect;}
    setAttribute() {}
  }
  const body = new Element();
  const area = nested ? new Element() : body;
  if (nested) {area.css.overflowY = 'auto'; body.appendChild(area);}
  const comment = new Element(); area.appendChild(comment);
  const dock = new Element(); dock.css.position = fixed ? 'fixed' : 'static';
  dock.rect = {top: 600, bottom: 800, left: 0, width: 1000, height: 200}; body.appendChild(dock);
  const editor = new Element(); dock.appendChild(editor);
  const root = new Element(); dock.appendChild(root); root.rect.height = 30;
  root.css.marginTop = root.css.marginBottom = '6px'; root.classList.toggle('bcr-collapsed', true);
  area.scrollTop = atBottom ? area.scrollHeight - area.clientHeight : 100;
  const window = {innerWidth: 1000, innerHeight: 800, getComputedStyle: element => element.css,
    addEventListener(name, fn) {listeners.set(name, fn);}, removeEventListener(name) {listeners.delete(name);},
    ResizeObserver: class {constructor(callback) {observer = this; this.callback = callback; this.observed = new Set();}
      observe(el) {this.observed.add(el);} unobserve(el) {this.observed.delete(el);} disconnect() {this.observed.clear();}}
  };
  const document = {body, documentElement: body, scrollingElement: body, defaultView: window,
    elementsFromPoint: () => [comment, area, body], createElement: () => new Element()};
  root.ownerDocument = document;
  const context = vm.createContext({}); vm.runInContext(source, context);
  const manager = context.BacklogPanelLayout.attach(root, editor);
  return {manager, root, dock, area, body, observer, listeners,
    expand(height = 300) {root.classList.toggle('bcr-collapsed', false); root.rect.height = height; root.css.marginTop = root.css.marginBottom = '12px'; manager.update();},
    collapse() {root.classList.toggle('bcr-collapsed', true); root.rect.height = 30; root.css.marginTop = root.css.marginBottom = '6px'; manager.update();},
    spacers: () => area.children.filter(child => child.className === 'bcr-comment-clearance')};
}
test('a docked panel reserves its added height in document and nested comment scroll areas', () => {
  for (const nested of [false, true]) {
    const f = fixture({nested}); const before = f.area.scrollHeight;
    f.expand();
    assert.equal(f.root.classList.contains('bcr-docked'), true);
    assert.equal(f.spacers().length, 1);
    assert.equal(f.area.scrollHeight - before, 282);
    assert.equal(f.area.scrollTop, f.area.scrollHeight - f.area.clientHeight);
    f.manager.update(); assert.equal(f.spacers().length, 1);
    f.collapse(); assert.equal(f.spacers().length, 0);
    assert.equal(f.area.scrollHeight, before);
  }
});
test('reading earlier comments retains the scroll offset as the panel grows', () => {
  const f = fixture({nested: true, atBottom: false});
  f.expand(); assert.equal(f.area.scrollTop, 100);
  f.expand(350); assert.equal(f.area.scrollTop, 100);
});
test('normal-flow composers do not add spacing or impose docked presentation', () => {
  const f = fixture({fixed: false}); f.expand();
  assert.equal(f.spacers().length, 0);
  assert.equal(f.root.classList.contains('bcr-docked'), false);
});

test('removing the native editor or panel also clears the reserved space', () => {
  const f = fixture({nested: true}); f.expand();
  f.root.isConnected = false; f.manager.update();
  assert.equal(f.spacers().length, 0);
  assert.equal(f.root.classList.contains('bcr-docked'), false);
});
test('leaving a dock or disposing removes spacing, observation and resize listeners', () => {
  const f = fixture({nested: true}); f.expand();
  f.dock.css.position = 'static'; f.manager.update();
  assert.equal(f.spacers().length, 0);
  f.dock.css.position = 'sticky'; f.manager.update();
  assert.equal(f.spacers().length, 1);
  f.manager.destroy();
  assert.equal(f.spacers().length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.observer.observed.size, 0);
});
test('fixed panels cap their height and keep the fold control visible inside their scroll area', () => {
  assert.match(css, /\.bcr-docked:not\(\.bcr-collapsed\)\{[^}]*max-height:45dvh;[^}]*overflow-y:auto/);
  assert.match(css, /\.bcr-docked:not\(\.bcr-collapsed\) \.bcr-header\{position:sticky/);
});
