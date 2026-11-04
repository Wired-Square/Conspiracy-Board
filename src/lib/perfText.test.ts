import { expect, test } from 'vitest';
import { perfText } from './perfText';

test('the report reads as lined-up columns, operations then the slowest calls', () => {
  const text = perfText({
    ops: [
      { name: 'update_card', count: 12, p50Ms: 3.25, p95Ms: 812, maxMs: 812, lastMs: 4, lastSize: { rowsIn: 0, rowsOut: 1, bytes: 4312 } },
      { name: 'ui:frame gap', count: 3, p50Ms: 60, p95Ms: 70, maxMs: 70, lastMs: 55.55, lastSize: { rowsIn: 0, rowsOut: 0, bytes: 0 } },
    ],
    slowest: [{ name: 'update_card', ms: 812, at: Date.UTC(2026, 10, 4, 1, 2, 3), rowsIn: 0, rowsOut: 1, bytes: 4312 }],
  });
  expect(text).toBe(
    [
      'Operations (ms), slowest first',
      'operation     calls   p50    p95    max  last  last bytes',
      'update_card      12   3.3  812.0  812.0   4.0        4312',
      'ui:frame gap      3  60.0   70.0   70.0  55.5           0',
      '',
      'Slowest calls',
      'at (UTC)                  operation       ms  rows in  rows out  bytes',
      '2026-11-04T01:02:03.000Z  update_card  812.0        0         1   4312',
    ].join('\n'),
  );
});
