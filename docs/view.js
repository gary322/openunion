import { copyToClipboard, el, toast } from '/ui/pw.js';

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, kind = '') {
  const el = $('status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('good', 'bad');
  if (kind) el.classList.add(kind);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isSafeHref(href) {
  const h = String(href || '').trim();
  if (!h) return false;
  if (h.startsWith('/')) return true;
  if (h.startsWith('#')) return true;
  return /^https?:\/\//i.test(h);
}

function inline(mdLine) {
  // Escape first, then apply lightweight inline formatting.
  let s = escapeHtml(mdLine);

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const safe = isSafeHref(href) ? href : '#';
    const attrs = safe.startsWith('http') ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${escapeHtml(safe)}"${attrs}>${escapeHtml(text)}</a>`;
  });

  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);

  // Bold: **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${escapeHtml(t)}</strong>`);

  // Italic: *text*
  s = s.replace(/\*([^*]+)\*/g, (_m, t) => `<em>${escapeHtml(t)}</em>`);

  return s;
}

function mdToHtml(md) {
  const lines = String(md || '').replaceAll('\r\n', '\n').split('\n');
  let out = '';
  let inCode = false;
  let codeLang = '';
  let listMode = null; // 'ul'|'ol'|null

  function closeList() {
    if (!listMode) return;
    out += listMode === 'ul' ? '</ul>\n' : '</ol>\n';
    listMode = null;
  }

  for (const raw of lines) {
    const line = raw ?? '';

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (inCode) {
        out += '</code></pre>\n';
        inCode = false;
        codeLang = '';
      } else {
        closeList();
        inCode = true;
        codeLang = String(fence[1] || '').trim();
        out += `<pre class="pw-codeblock"><code data-lang="${escapeHtml(codeLang)}">`;
      }
      continue;
    }

    if (inCode) {
      out += `${escapeHtml(line)}\n`;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = String(h[2] || '').trim();
      const id = slugify(text) || `h${level}`;
      out += `<h${level} id="${escapeHtml(id)}">${inline(text)}</h${level}>\n`;
      continue;
    }

    const ul = line.match(/^\s*-\s+(.*)$/);
    if (ul) {
      if (listMode !== 'ul') {
        closeList();
        listMode = 'ul';
        out += '<ul>\n';
      }
      out += `<li>${inline(ul[1])}</li>\n`;
      continue;
    }

    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      if (listMode !== 'ol') {
        closeList();
        listMode = 'ol';
        out += '<ol>\n';
      }
      out += `<li>${inline(ol[2])}</li>\n`;
      continue;
    }

    if (!line.trim()) {
      closeList();
      out += '\n';
      continue;
    }

    closeList();
    out += `<p>${inline(line)}</p>\n`;
  }

  closeList();
  if (inCode) out += '</code></pre>\n';
  return out;
}

function safePathFromQuery() {
  const url = new URL(window.location.href);
  const raw = String(url.searchParams.get('path') ?? '').trim();
  if (!raw) return 'runbooks/ThirdPartyOnboarding.md';
  if (raw.startsWith('/')) return 'runbooks/ThirdPartyOnboarding.md';
  if (raw.includes('..')) return 'runbooks/ThirdPartyOnboarding.md';
  return raw;
}

function encodePath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function renderToc(root) {
  const toc = $('toc');
  if (!toc) return;
  const headings = Array.from(root.querySelectorAll('h1, h2, h3'));
  if (!headings.length) {
    toc.replaceChildren(el('div', { class: 'pw-muted', text: 'No sections' }));
    return;
  }

  const items = headings.map((h) => {
    const id = h.getAttribute('id') || '';
    const name = String(h.textContent || '').trim();
    const href = id ? `#${id}` : '#';
    const link = el('a', { class: 'pw-link', href, text: name });
    return link;
  });
  toc.replaceChildren(...items);
}

async function load() {
  const path = safePathFromQuery();
  const rawUrl = `/docs/${encodePath(path)}`;

  const btnOpenRaw = $('btnOpenRaw');
  if (btnOpenRaw) btnOpenRaw.setAttribute('href', rawUrl);

  $('docKicker').textContent = path;
  setStatus('');

  try {
    const res = await fetch(rawUrl, { credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      setStatus(`Failed to load (${res.status})`, 'bad');
      $('content').textContent = text || 'not found';
      return;
    }

    const title = path.split('/').slice(-1)[0] || 'Doc';
    document.title = `Proofwork • ${title}`;
    $('docTitle').textContent = title.replace(/\.md$/i, '');

    const html = mdToHtml(text);
    const content = $('content');
    content.innerHTML = html;
    const firstH1 = content.querySelector('h1');
    if (firstH1 && String(firstH1.textContent || '').trim()) {
      $('docTitle').textContent = String(firstH1.textContent || '').trim();
      // Avoid duplicate H1: we use the page hero title.
      firstH1.remove();
    }
    renderToc(content);
  } catch (err) {
    setStatus('Failed to load doc.', 'bad');
    $('content').textContent = String(err?.message ?? err);
  }

  const btnCopy = $('btnCopyLink');
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      await copyToClipboard(window.location.href);
    });
  }
}

load().catch(() => toast('Failed to load doc', 'bad'));
