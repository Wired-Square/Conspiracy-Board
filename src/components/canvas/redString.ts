import { floatingAnchors, type EdgeView } from '@wired-square/canvas/core';
import type { StringEdge, StringEdgeData } from '../../types/canvas';
import { gradeTint } from '../../lib/grades';
import { yarnPath } from '../../lib/yarn';

function shape<K extends 'path' | 'circle'>(parent: SVGGElement, tag: K, className: string) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  element.setAttribute('class', className);
  parent.append(element);
  return element;
}

/** Draws a string into the canvas's edge group, and its tag into the label. */
export function mountRedString(group: SVGGElement, label: HTMLElement, edge: StringEdge): EdgeView<StringEdgeData> {
  // A derived link hangs under the same gravity but is drawn as one thin, faint
  // strand: no shadow, no sheen, no knots. Nobody pinned it — the app inferred
  // it from an address, and it must not read as something a hand tied to the board.
  const participant = edge.data.variant === 'participant';
  const strands = participant
    ? [shape(group, 'path', 'derived-string__strand')]
    : ['shadow', 'strand', 'sheen'].map((layer) => shape(group, 'path', `red-string__${layer}`));
  const knots = participant ? [] : [0, 1].map(() => shape(group, 'circle', 'red-string__knot'));
  for (const knot of knots) knot.setAttribute('r', '4');
  label.classList.add('red-string__tag');

  return {
    draw({ data }, { source, target }) {
      const ends = floatingAnchors(source, target);
      const { path, labelX, labelY } = yarnPath(ends.source.x, ends.source.y, ends.target.x, ends.target.y);
      for (const strand of strands) strand.setAttribute('d', path);
      knots.forEach((knot, i) => {
        const end = i ? ends.target : ends.source;
        knot.setAttribute('cx', String(end.x));
        knot.setAttribute('cy', String(end.y));
      });
      // A derived link is always the Inference violet: that is precisely the claim it makes.
      const grade = participant ? 'inference' : data.grade;
      const tint = grade ? Object.entries(gradeTint(grade)) : [];
      group.setAttribute('style', tint.map(([name, value]) => `${name}: ${value}`).join('; '));
      label.hidden = !data.label;
      label.textContent = data.label ?? '';
      label.style.transform = `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) rotate(-2deg)`;
    },
  };
}
