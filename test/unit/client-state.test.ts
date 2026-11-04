import { describe, expect, it } from 'vitest';
import { fullJitterDelay } from '../../public/js/backoff.js';
import { createResultsState, summarize } from '../../public/js/results-state.js';

const snapshot = { topic: 'dep', seq: 5, state: { 'v:C1': 10, mesas_totales: 100 } };

describe('estado del cliente público', () => {
  it('aplica deltas encadenados e ignora los ya vistos', () => {
    const state = createResultsState();
    state.applySnapshot(snapshot);
    const delta = { topic: 'dep', seq: 7, prev: 5, changes: { 'v:C1': 12 } };
    expect(state.applyDelta(delta)).toBe('applied');
    expect(state.applyDelta(delta)).toBe('ignored');
    expect(state.view('dep')?.values['v:C1']).toBe(12);
    expect(state.cursor('dep')).toBe(7);
  });

  it('detecta el hueco y no aplica el delta', () => {
    const state = createResultsState();
    state.applySnapshot(snapshot);
    expect(state.applyDelta({ topic: 'dep', seq: 9, prev: 7, changes: { 'v:C1': 99 } })).toBe(
      'gap',
    );
    expect(state.view('dep')?.values['v:C1']).toBe(10);
  });

  it('resume ranking y porcentaje', () => {
    const summary = summarize({
      'v:C1': 5,
      'v:C2': 9,
      'v:BLANCO': 100,
      mesas_informadas: 25,
      mesas_totales: 100,
    });
    expect(summary.ranking.map((r) => r.candidate)).toEqual(['C2', 'C1']);
    expect(summary.percent).toBe(25);
  });
});

describe('fullJitterDelay', () => {
  it('queda entre cero y el tope, y el tope crece hasta el máximo', () => {
    const options = { baseMs: 1000, capMs: 8000 };
    expect(fullJitterDelay(0, options, () => 0)).toBe(0);
    expect(fullJitterDelay(0, options, () => 0.999)).toBe(999);
    expect(fullJitterDelay(2, options, () => 0.999)).toBe(3996);
    expect(fullJitterDelay(30, options, () => 0.999)).toBe(7992);
  });
});
