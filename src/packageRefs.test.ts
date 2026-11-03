import { expect, test } from 'vitest';
import pkg from '../package.json?raw';
import workspace from '../pnpm-workspace.yaml?raw';
import lockfile from '../pnpm-lock.yaml?raw';

const localRef = /\b(?:file|link|portal|patch):|patchedDependencies|patch_hash/;

test.each([
  ['package.json', pkg],
  ['pnpm-workspace.yaml', workspace],
  ['pnpm-lock.yaml', lockfile],
])('%s takes every package from a registry, unpatched', (_, text) => {
  expect(text.split('\n').filter((line) => localRef.test(line))).toEqual([]);
});
