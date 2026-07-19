// Convert an HTML email body into the markdown-ish plain text that `notes`
// already holds.
//
// Security note: DOMParser.parseFromString builds an *inert* document — scripts
// do not execute and <img>/<link> do not fetch — so untrusted email markup is
// safe to walk here. It is never handed to a renderer as HTML: react-markdown
// escapes HTML by default, and adding rehype-raw would turn an email into an
// XSS vector.

const BLOCK = new Set([
  'P', 'DIV', 'TR', 'BR', 'LI', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
]);

const HEADING: Record<string, string> = {
  H1: '# ', H2: '## ', H3: '### ', H4: '#### ', H5: '##### ', H6: '###### ',
};

function walk(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    // Collapse HTML's insignificant whitespace, but keep single spaces.
    const text = (node.textContent ?? '').replace(/\s+/g, ' ');
    if (text) out.push(text);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName;

  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD' || tag === 'NOSCRIPT') return;

  if (tag === 'BR') {
    out.push('\n');
    return;
  }
  if (tag === 'HR') {
    out.push('\n---\n');
    return;
  }

  if (BLOCK.has(tag)) out.push('\n');
  if (HEADING[tag]) out.push(HEADING[tag]);
  if (tag === 'LI') out.push('- ');

  if (tag === 'A') {
    const href = el.getAttribute('href')?.trim();
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Skip the link syntax when it would just duplicate the URL, or when the
    // anchor is a tracking pixel wrapper with no text.
    if (href && text && href !== text && !href.startsWith('mailto:')) {
      out.push(`[${text}](${href})`);
      return;
    }
    if (text) out.push(text);
    return;
  }

  for (const child of Array.from(el.childNodes)) walk(child, out);

  if (BLOCK.has(tag)) out.push('\n');
}

export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  walk(doc.body, out);

  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
