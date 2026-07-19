import type { MediaIconType } from '../../lib/mediaIcon';

// A small inline-SVG icon set for the kinds of file a board holds: a document, an
// image, a movie, a sound, and the message itself. Hand-drawn line glyphs on a
// 24×24 grid, `currentColor` so they take the surrounding ink and theme — no icon
// dependency, matching the rest of the UI (see ui/Menu). Sized in `em`, so a caller
// sets the size with font-size on the box that holds it.
//
// A paperclip rides in the corner when the file came in on an email: provenance,
// drawn over whatever the base type is, not a type of its own.

// Shared stroke style. The play triangle and note-heads set their own fill.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Glyph({ type }: { type: MediaIconType }) {
  switch (type) {
    case 'document':
      return (
        <>
          <path d="M7 3.5h6l4 4v12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6 19.5v-14A1.5 1.5 0 0 1 7 3.5Z" />
          <path d="M13 3.5V7.5h4" />
          <path d="M9 12.5h6M9 15.5h6" />
        </>
      );
    case 'image':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.6" />
          <path d="M4 17l4.5-4.5 3 3 4-4 4.5 4.5" />
        </>
      );
    case 'movie':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M10 9.4v5.2l4.6-2.6Z" fill="currentColor" stroke="none" />
        </>
      );
    case 'sound':
      return (
        <>
          <path d="M4 9.5h3l4-3.5v12l-4-3.5H4Z" />
          <path d="M15 9.2a4 4 0 0 1 0 5.6" />
          <path d="M17.6 6.6a7.5 7.5 0 0 1 0 10.8" />
        </>
      );
    case 'email':
      return (
        <>
          <rect x="2.5" y="5" width="19" height="14" rx="2" />
          <path d="M3 6.5l9 6.5 9-6.5" />
        </>
      );
    case 'message':
      return (
        <>
          <path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V15.5H4A1.5 1.5 0 0 1 2.5 14V6A1.5 1.5 0 0 1 4 4.5Z" />
          <path d="M7 9h10M7 12h6" />
        </>
      );
    case 'call':
      return (
        <path d="M7 3.5 4.8 5.7a2 2 0 0 0-.5 2A16 16 0 0 0 16.3 19.7a2 2 0 0 0 2-.5L20.5 17a1 1 0 0 0-.2-1.6l-3-1.5a1 1 0 0 0-1.1.2l-1 1a12 12 0 0 1-5.3-5.3l1-1a1 1 0 0 0 .2-1.1l-1.5-3A1 1 0 0 0 7 3.5Z" />
      );
  }
}

export function MediaIcon({ type, attachment = false }: { type: MediaIconType; attachment?: boolean }) {
  return (
    <span className={`media-icon media-icon--${type}`} aria-hidden>
      <svg viewBox="0 0 24 24" {...STROKE}>
        <Glyph type={type} />
      </svg>
      {attachment && (
        <svg className="media-icon__clip" viewBox="0 0 24 24" {...STROKE}>
          <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
        </svg>
      )}
    </span>
  );
}
