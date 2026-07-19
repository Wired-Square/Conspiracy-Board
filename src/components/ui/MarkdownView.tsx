import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Notes can hold the body of an imported, untrusted email, so react-markdown's
// defaults do the work here: HTML is escaped and URLs are sanitised, which is
// what keeps a javascript: link inside someone else's message inert. Nothing in
// this app writes markdown that needs an exemption from that — the way back to
// Apple Mail is a real link in the editor, not prose (see EmailFields).
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
