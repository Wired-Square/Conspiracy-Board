import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

// Notes can hold the body of an imported, untrusted email, so micromark's
// defaults do the work here: HTML is escaped and URLs are sanitised, which is
// what keeps a javascript: link inside someone else's message inert. Never pass
// allowDangerousHtml or allowDangerousProtocol — the way back to Apple Mail is a
// real link in the editor, not prose (see EmailFields).
const options = { extensions: [gfm()], htmlExtensions: [gfmHtml()] };

export function MarkdownView(props: { children: string }) {
  return <div class="markdown" innerHTML={micromark(props.children, options)} />;
}
