import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const marked = await readFile(new URL('../vendor/marked/marked.umd.js', import.meta.url), 'utf8');
const renderer = await readFile(new URL('../chat-markdown.js', import.meta.url), 'utf8');

function fixture() {
  class Element {
    constructor(tag, ownerDocument) {this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.className = '';}
    appendChild(child) {this.children.push(child); return child;}
    replaceChildren(...children) {this.children = children;}
    set textContent(text) {this.children = [{tagName: '#text', textContent: String(text)}];}
    get textContent() {return this.children.map(child => child.textContent).join('');}
    set innerHTML(_) {throw new Error('HTML injection is prohibited');}
  }
  const doc = {createElement: tag => new Element(tag, doc), createTextNode: text => ({tagName: '#text', textContent: String(text)})};
  const context = vm.createContext({URL, document: doc, location: {href: 'https://example.backlog.com/view/TEST-1'}});
  vm.runInContext(marked, context);
  vm.runInContext(renderer, context);
  const root = doc.createElement('div');
  return {root, render: text => context.BacklogChatMarkdown.render(root, text)};
}
function descendants(root, tag) {
  return [root, ...(root.children || []).flatMap(child => descendants(child, tag))].filter(node => node.tagName === tag.toUpperCase());
}

test('GFM headings, nested emphasis, lists, code, and tables render as structured DOM', () => {
  const f = fixture();
  const markdown = '# 見出し\n\n説明 **大切** と *注意*\n\n| 名前 | 状態 |\n| --- | --- |\n| **A** | 完了 |\n\n- 項目\n- `code`\n\n```js\nconst x = 1;\n```';
  f.render(markdown);
  assert.equal(descendants(f.root, 'h1')[0].textContent, '見出し');
  assert.equal(descendants(f.root, 'strong').map(node => node.textContent).join(','), '大切,A');
  assert.equal(descendants(f.root, 'em')[0].textContent, '注意');
  assert.equal(descendants(f.root, 'table').length, 1);
  assert.equal(descendants(f.root, 'th').length, 2);
  assert.equal(descendants(f.root, 'td')[0].textContent, 'A');
  assert.equal(descendants(f.root, 'li').length, 2);
  assert.equal(descendants(f.root, 'pre')[0].textContent, 'const x = 1;');
  assert.equal(markdown.includes('**大切**'), true);
});

test('untrusted HTML is text, unsafe URLs are not links, and images never load', () => {
  const f = fixture();
  f.render('**安全** <img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1)) [data](data:text/html,x) [safe](https://example.com/a) ![画像](https://attacker.example/track.png)');
  assert.equal(descendants(f.root, 'img').length, 0);
  assert.equal(descendants(f.root, 'script').length, 0);
  assert.match(f.root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(descendants(f.root, 'a').length, 1);
  const link = descendants(f.root, 'a')[0];
  assert.equal(link.href, 'https://example.com/a');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(f.root.textContent, /unsafe/);
  assert.match(f.root.textContent, /\[画像: 画像\]/);
});

test('renders line breaks, entities and relative links without mutating the input', () => {
  const f = fixture();
  const text = 'A &amp; B\n次の行 [課題](/view/TEST-2)';
  f.render(text);
  assert.equal(descendants(f.root, 'br').length, 1);
  assert.match(f.root.textContent, /A & B/);
  assert.equal(descendants(f.root, 'a')[0].href, 'https://example.backlog.com/view/TEST-2');
  assert.equal(text, 'A &amp; B\n次の行 [課題](/view/TEST-2)');
});
