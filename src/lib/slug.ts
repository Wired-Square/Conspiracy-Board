/**
 * A filename-safe slug of a board title, for export downloads.
 *
 * NFKD-normalises first so an accented letter keeps its base character
 * ("Café" → "cafe") instead of being dropped along with the accent.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // the combining marks NFKD just split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, ''); // slicing can leave a trailing dash

  return slug || 'board';
}
