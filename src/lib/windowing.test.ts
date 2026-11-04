import { expect, test } from 'vitest';
import { itemsIn, offsetsOf } from './windowing';

const widths = [10, 20, 30, 40];
const offsets = offsetsOf(widths.length, (i) => widths[i]);

test('offsets run end to end and close with the total', () => {
  expect(offsets).toEqual([0, 10, 30, 60, 100]);
  expect(offsetsOf(0, () => 1)).toEqual([0]);
});

test('a window holds every item it overlaps, even by a pixel', () => {
  expect(itemsIn(offsets, 0, 10)).toEqual({ start: 0, end: 1 });
  expect(itemsIn(offsets, 9, 11)).toEqual({ start: 0, end: 2 });
  expect(itemsIn(offsets, 10, 30)).toEqual({ start: 1, end: 2 });
  expect(itemsIn(offsets, 35, 61)).toEqual({ start: 2, end: 4 });
});

test('a window off either end of the run, or of an empty one, holds what it reaches', () => {
  expect(itemsIn(offsets, -50, 5)).toEqual({ start: 0, end: 1 });
  expect(itemsIn(offsets, 90, 500)).toEqual({ start: 3, end: 4 });
  expect(itemsIn(offsets, 100, 200)).toEqual({ start: 4, end: 4 });
  expect(itemsIn([0], 0, 100)).toEqual({ start: 0, end: 0 });
});

test('uniform rows window by row height', () => {
  const rows = offsetsOf(10_000, () => 50);
  expect(itemsIn(rows, 5_000 - 200, 5_000 + 800 + 200)).toEqual({ start: 96, end: 120 });
});
