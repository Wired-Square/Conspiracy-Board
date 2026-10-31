import { describe, expect, it } from 'vitest';
import { awaitFit, FIT_WAIT_MS, settleFit } from './pendingFit';

const drawn = (...ids: string[]) => (id: string) => ids.includes(id);

describe('pending fit', () => {
  it('fits at once when every id is already drawn', () => {
    expect(awaitFit({ ids: ['a', 'b'] }, drawn('a', 'b'), 0)).toBeNull();
  });

  it('waits for a new card the canvas has not drawn yet, then fits once it is', () => {
    const fit = awaitFit({ ids: ['old', 'new'], padding: 0.4 }, drawn('old'), 0)!;
    expect(fit.options.padding).toBe(0.4);
    expect(settleFit(fit, drawn('old'), 10)).toBe('wait');
    expect(settleFit(fit, drawn('old', 'new'), 20)).toBe('fit');
  });

  it('fits once any awaited id is drawn, passing over one the board never draws', () => {
    const fit = awaitFit({ ids: ['new', 'hidden'] }, drawn(), 0)!;
    expect(settleFit(fit, drawn('new'), 10)).toBe('fit');
  });

  it('drops a request whose ids never appear in time', () => {
    const fit = awaitFit({ ids: ['new'] }, drawn(), 0)!;
    expect(settleFit(fit, drawn('new'), FIT_WAIT_MS + 1)).toBe('drop');
  });
});
