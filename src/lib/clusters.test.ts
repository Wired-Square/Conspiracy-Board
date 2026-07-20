import { describe, expect, it } from 'vitest';
import type { Cluster } from '../types/board';
import {
  clusterColor,
  extraClusterColors,
  hiddenClusterIds,
  isVisible,
  primaryClusterId,
} from './clusters';

const clusters: Cluster[] = [
  { id: 'cl_a', label: 'Players', color: '#e23b3b', visible: true },
  { id: 'cl_b', label: 'Money', color: '#3b7de2', visible: false },
  { id: 'cl_c', label: 'Places', color: '#3bd17a', visible: true },
];

describe('primaryClusterId', () => {
  it('is the first membership', () => {
    expect(primaryClusterId(['cl_b', 'cl_a'])).toBe('cl_b');
  });

  it('is null for a clusterless card', () => {
    expect(primaryClusterId([])).toBeNull();
  });
});

describe('extraClusterColors', () => {
  it('resolves the non-primary colours in order', () => {
    expect(extraClusterColors(['cl_a', 'cl_c', 'cl_b'], clusters)).toEqual([
      '#3bd17a',
      '#3b7de2',
    ]);
  });

  it('drops a membership of a cluster that no longer exists', () => {
    expect(extraClusterColors(['cl_a', 'cl_gone'], clusters)).toEqual([]);
  });

  it('is empty for single or no membership', () => {
    expect(extraClusterColors(['cl_a'], clusters)).toEqual([]);
    expect(extraClusterColors([], clusters)).toEqual([]);
  });
});

describe('isVisible', () => {
  const hidden = hiddenClusterIds(clusters);

  it('always shows a clusterless card', () => {
    expect(isVisible([], hidden)).toBe(true);
  });

  it('hides a card whose every cluster is hidden', () => {
    expect(isVisible(['cl_b'], hidden)).toBe(false);
  });

  it('shows a card with at least one visible cluster, wherever it sits', () => {
    expect(isVisible(['cl_b', 'cl_a'], hidden)).toBe(true);
    expect(isVisible(['cl_a', 'cl_b'], hidden)).toBe(true);
  });
});

describe('clusterColor', () => {
  it('resolves a cluster to its colour, and anything else to null', () => {
    expect(clusterColor('cl_a', clusters)).toBe('#e23b3b');
    expect(clusterColor('cl_gone', clusters)).toBeNull();
    expect(clusterColor(null, clusters)).toBeNull();
  });
});
