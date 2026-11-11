(function (global) {
  'use strict';

  // Build nodes from Marked's GFM tokens instead of injecting its generated HTML.
  // Issue content and model output can both contain attacker-controlled markup.
  function decodeEntities(value) {
    const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity[0] !== '#') return named[entity.toLowerCase()] || match;
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '\ufffd';
    });
  }
  function safeHref(value) {
    try {
      const url = new URL(decodeEntities(value), global.location?.href || 'https://invalid.example/');
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {return null;}
  }
  function render(target, markdown) {
    const doc = target.ownerDocument || global.document;
    const node = (tag, text) => {
      const element = doc.createElement(tag);
      if (text !== undefined) element.textContent = text;
      return element;
    };
    function inline(parent, tokens) {
      for (const token of tokens || []) {
        let element;
        switch (token.type) {
          case 'text':
          case 'escape':
            if (token.tokens) inline(parent, token.tokens);
            else parent.appendChild(doc.createTextNode(decodeEntities(token.text)));
            break;
          case 'strong': case 'em': case 'del':
            element = node(token.type); inline(element, token.tokens); parent.appendChild(element); break;
          case 'codespan':
            parent.appendChild(node('code', token.text)); break;
          case 'br':
            parent.appendChild(node('br')); break;
          case 'link': {
            const href = safeHref(token.href);
            element = node(href ? 'a' : 'span');
            if (href) {
              element.href = href;
              element.target = '_blank';
              element.rel = 'noopener noreferrer';
              if (token.title) element.title = decodeEntities(token.title);
            }
            inline(element, token.tokens); parent.appendChild(element); break;
          }
          case 'image':
            // Do not automatically fetch model-provided image URLs.
            parent.appendChild(doc.createTextNode(token.text ? `[画像: ${decodeEntities(token.text)}]` : '[画像]')); break;
          case 'html':
            parent.appendChild(doc.createTextNode(token.raw || token.text || '')); break;
          default:
            parent.appendChild(doc.createTextNode(token.text || token.raw || ''));
        }
      }
    }
    function blocks(parent, tokens) {
      for (const token of tokens || []) {
        let element;
        switch (token.type) {
          case 'space': case 'def': break;
          case 'heading':
            element = node(`h${Math.max(1, Math.min(6, token.depth))}`); inline(element, token.tokens); parent.appendChild(element); break;
          case 'paragraph':
            element = node('p'); inline(element, token.tokens); parent.appendChild(element); break;
          case 'text':
            element = node('p'); token.tokens ? inline(element, token.tokens) : element.appendChild(doc.createTextNode(decodeEntities(token.text)));
            parent.appendChild(element); break;
          case 'blockquote':
            element = node('blockquote'); blocks(element, token.tokens); parent.appendChild(element); break;
          case 'code':
            element = node('pre'); element.appendChild(node('code', token.text)); parent.appendChild(element); break;
          case 'hr': parent.appendChild(node('hr')); break;
          case 'list':
            element = node(token.ordered ? 'ol' : 'ul');
            if (token.ordered && Number.isSafeInteger(token.start) && token.start > 0) element.start = token.start;
            for (const item of token.items || []) {
              const li = node('li');
              if (item.task) li.appendChild(doc.createTextNode(item.checked ? '☑ ' : '☐ '));
              blocks(li, item.tokens); element.appendChild(li);
            }
            parent.appendChild(element); break;
          case 'table': {
            const wrap = node('div'); wrap.className = 'bcr-markdown-table-wrap';
            const table = node('table'); const thead = node('thead'); const row = node('tr');
            for (const cell of token.header || []) {const th = node('th'); inline(th, cell.tokens); row.appendChild(th);}
            thead.appendChild(row); table.appendChild(thead);
            const tbody = node('tbody');
            for (const cells of token.rows || []) {
              const tr = node('tr');
              for (const cell of cells) {const td = node('td'); inline(td, cell.tokens); tr.appendChild(td);}
              tbody.appendChild(tr);
            }
            table.appendChild(tbody); wrap.appendChild(table); parent.appendChild(wrap); break;
          }
          case 'html':
            parent.appendChild(node('p', token.raw || token.text || '')); break;
          default:
            parent.appendChild(node('p', token.raw || token.text || ''));
        }
      }
    }
    target.replaceChildren();
    try { blocks(target, global.marked.lexer(String(markdown || ''), {gfm: true, breaks: true})); }
    catch { target.textContent = String(markdown || ''); }
  }
  global.BacklogChatMarkdown = Object.freeze({render});
})(globalThis);
