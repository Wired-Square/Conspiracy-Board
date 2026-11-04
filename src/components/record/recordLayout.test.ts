// @vitest-environment jsdom
import { expect, test } from 'vitest';
import css from '../../index.css?raw';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { ClusterPanel } from '../panels/ClusterPanel';
import { RecordView } from './RecordView';

test('the record view keeps its right edge clear of the open cluster panel', () => {
  document.head.appendChild(document.createElement('style')).textContent = css;
  boardStore.setState({ clusters: [], cards: [], connections: [], searchQuery: '', selectedCardId: null });
  const canvas = document.body.appendChild(document.createElement('div'));
  canvas.className = 'app__canvas';
  render(RecordView, canvas);
  render(ClusterPanel, canvas.appendChild(document.createElement('div')));

  const inset = () => getComputedStyle(canvas.querySelector('.record')!).paddingRight;
  // jsdom leaves var() unresolved, so the inset is matched as the panel's width plus its margin.
  expect(inset()).toBe(`calc(${getComputedStyle(canvas.querySelector('.cluster-panel')!).width} + 1rem)`);
  canvas.querySelector<HTMLButtonElement>('.cluster-panel__toggle')!.click();
  expect(inset()).toBe('0');
});
