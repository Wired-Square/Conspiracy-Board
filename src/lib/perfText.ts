import type { PerfReport } from '../bindings/PerfReport';

const ms = (n: number) => n.toFixed(1);

/** Columns padded to line up, the first `labels` of them left-aligned and the rest right. */
function columns(rows: string[][], labels: number): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i < labels ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** The report as plain text, to paste into a note or an issue. */
export function perfText(report: PerfReport): string {
  const ops = report.ops.map((o) => [o.name, String(o.count), ms(o.p50Ms), ms(o.p95Ms), ms(o.maxMs), ms(o.lastMs)]);
  const calls = report.slowest.map((c) => [
    new Date(c.at).toISOString(),
    c.name,
    ms(c.ms),
    String(c.rowsIn),
    String(c.rowsOut),
    String(c.bytes),
  ]);
  return [
    'Operations (ms), slowest first',
    columns([['operation', 'calls', 'p50', 'p95', 'max', 'last'], ...ops], 1),
    '',
    'Slowest calls',
    columns([['at (UTC)', 'operation', 'ms', 'rows in', 'rows out', 'bytes'], ...calls], 2),
  ].join('\n');
}
