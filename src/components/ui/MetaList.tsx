// A compact read-only key/value list for the metadata read out of an imported file
// — a document's properties, a photo's EXIF. The facts are pre-formatted strings;
// the caller decides what a document card versus an image card has to show.

export function MetaList({ facts }: { facts: [string, string][] }) {
  if (!facts.length) return null;
  return (
    <dl className="media-meta">
      {facts.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
