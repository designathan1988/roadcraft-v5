import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type MultiPoly, area, union } from '@core/clipper';

/** A UNION THAT RAN OUT OF MEMORY (2026-10-16): four footway rings of the whole city's tile -5,-2 (seed 1), the fourth a ring that comes back to its first point and goes on with seven points a tenth of a millimetre apart (a spike of no width); Clipper2's port looped on it, the tile's worker grew to 2.9 GB and the page's V8 cage (4 GB) died. */
describe('a union of degenerate footway rings', () => {
  it('ends, in the area the rings cover', () => {
    const rings = JSON.parse(readFileSync('tests/fixtures/clipper-union-seed1-tile-5-2.json', 'utf8')) as MultiPoly;
    const out = union(rings);
    expect(out.length).toBeGreaterThan(0);
  });
});

/** A UNION WITH NOTHING ON ONE SIDE (2026-10-18): `union([], b)` came back empty, and the far roads' bands, each cut by the union of those under it begun empty, were never cut. */
describe('a union of two sets', () => {
  it('holds both, whichever is empty', () => {
    const square = (x: number): MultiPoly => [[[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]]]];
    expect(area(union([], square(0)))).toBeCloseTo(1, 6);
    expect(area(union(square(0), []))).toBeCloseTo(1, 6);
    expect(area(union(square(0), square(3)))).toBeCloseTo(2, 6);
  });
});
