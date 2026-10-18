import type { CellMass } from '@render/buildings/cellArrays';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { EDGE_INSET, MAP_HALF, WHOLE_MAP_DEFAULTS, type WholeMapOptions, planWholeMap } from '@world/cityGen/wholeMap';
import { lotCentre } from '@world/lots';
import { OWNER, TILE, TILE_COUNTED, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { buildStreamTile, buildStreamTilePair } from '@editor/wholeMapTile';
import { type FarCache, type FarJob, bakeTileMasses, farKey, keepTileFar, runFarJob, tileSquare } from '@render/buildings/farTiles';
import { TILE_DETAIL } from '@render/buildings/massing';
import { type FarRoadCache, type FarRoadJob, bakeTileRoads, runFarRoadJob, tileRoads } from '@render/farRoadTiles';
import { tileBuildingsOf } from '@world/growth/grownRows';
import type { JobScope } from '@/jobs/jobScope';
import { type StreamTileAnswer, type StreamTileAsk, serve } from '@/cityTile.worker';

/** THE STREAMED WORLD'S TILES (`editor/wholeMapTile.ts` `buildStreamTile`, `world/tiles.ts`): any tile of the unbounded world built alone, as the tile store keeps it - what it owns, ids in its own range, the nodes on its edges named by their place so two neighbours built apart agree. A tile takes seconds: the pair is the least built-up one round the origin. */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 3 };

type Place = { readonly x: number; readonly y: number };
const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Two tiles side by side (i, j) and (i + 1, j): the least built-up pair within 4 km of the origin. */
function coolPair(): [number, number] {
  const map = planWholeMap(options);
  let best: [number, number] = [0, 0], heat = Infinity;
  for (let j = -4; j < 4; j++) {
    for (let i = -4; i < 3; i++) {
      const h = map.tile(i, j).heat + map.tile(i + 1, j).heat;
      if (h < heat) { heat = h; best = [i, j]; }
    }
  }
  return best;
}

/** Every record of the tile is its own, every id in its range (or an edge's, by its place), every reference found in the tile. */
function checkTile(r: TileRecords, i: number, j: number): void {
  const key = tileKey(i, j);
  expect(r.key).toBe(key);
  expect(r.version).toBe(1);
  const base = tileIdBase(key);
  const counted = (id: number): boolean => Number.isInteger(id) && id >= base && id < base + TILE_COUNTED;
  const ids = <T extends { readonly id: number }>(kind: keyof TileRecords['next'], list: readonly T[]): Set<number> => {
    const out = new Set<number>();
    for (const item of list) {
      expect(out.has(item.id), `${kind} ${item.id} twice`).toBe(false);
      out.add(item.id);
      if (kind !== 'node') {
        expect(counted(item.id), `${kind} ${item.id} out of the tile's range`).toBe(true);
        expect(item.id).toBeLessThan(r.next[kind]);
      }
    }
    return out;
  };

  // ---- nodes: owned where they stand; on an edge named by the place, else counted
  for (const n of r.nodes) {
    expect(OWNER.node(n), `node at (${n.x}, ${n.y}) not the tile's`).toBe(key);
    const edge = edgeNodeId(n.x, n.y);
    if (edge !== null) expect(n.id).toBe(edge);
    else {
      expect(counted(n.id)).toBe(true);
      expect(n.id).toBeLessThan(r.next.node);
    }
  }
  for (const n of r.borrowedNodes) {
    expect(OWNER.node(n), `borrowed node at (${n.x}, ${n.y}) is the tile's own`).not.toBe(key);
    // A road leaves the tile only across an edge: its foreign end is on the edge's line, exactly.
    expect(n.x === Math.round(n.x / TILE) * TILE || n.y === Math.round(n.y / TILE) * TILE, `borrowed node off the edges at (${n.x}, ${n.y})`).toBe(true);
    expect(n.id).toBe(edgeNodeId(n.x, n.y));
  }
  const nodeIds = ids('node', [...r.nodes, ...r.borrowedNodes]);
  const place = new Map<number, Place>([...r.nodes, ...r.borrowedNodes].map((n) => [n.id, n]));

  // ---- roads: owned by the middle of their ends, both ends in the tile's nodes or borrowed
  const segmentIds = ids('segment', r.segments);
  for (const s of r.segments) {
    expect(nodeIds.has(s.a) && nodeIds.has(s.b), `road ${s.id} ends outside the tile's nodes`).toBe(true);
    expect(OWNER.segment(place.get(s.a)!, place.get(s.b)!)).toBe(key);
  }
  for (const n of r.nodes) {
    if (n.crossing) expect(segmentIds.has(n.crossing.segment)).toBe(true);
    for (const l of n.laneLinks ?? []) expect(segmentIds.has(l.from) && segmentIds.has(l.to)).toBe(true);
    for (const rule of n.approachRules ?? []) expect(segmentIds.has(rule.segment)).toBe(true);
    if (n.uturn !== undefined) expect(segmentIds.has(n.uturn)).toBe(true);
    for (const movement of n.blockedMovements ?? []) {
      const [from, to] = movement.split('>').map(Number);
      expect(segmentIds.has(from!) && segmentIds.has(to!), `movement ${movement}`).toBe(true);
    }
  }

  // ---- what stands on the land: by its anchor, ids counted, a lot's building found in the tile; the grown ones as rows, each made again on the lot that names it
  const buildings = tileBuildingsOf(r) as readonly { readonly id: number; readonly x: number; readonly y: number }[];
  expect(buildings.length).toBe(r.buildings.length + (r.grown?.id.length ?? 0));
  const buildingIds = ids('building', buildings);
  for (const b of buildings) expect(OWNER.at(b)).toBe(key);
  ids('lot', r.lots);
  const named = new Map(r.lots.flatMap((l) => (l.building !== undefined ? [[l.building, l.id] as const] : [])));
  r.grown?.id.forEach((id, k) => expect(named.get(id), `grown building ${id} on the lot that names it`).toBe(r.grown!.lot[k]));
  for (const l of r.lots) {
    expect(OWNER.at(lotCentre(l))).toBe(key);
    if (l.building !== undefined) expect(buildingIds.has(l.building), `lot ${l.id} names building ${l.building}`).toBe(true);
  }
  const poleIds = ids('pole', [...r.poles, ...r.borrowedPoles]);
  for (const p of r.poles) expect(OWNER.at(p)).toBe(key);
  ids('span', r.poleSpans);
  for (const s of r.poleSpans) expect(poleIds.has(s.a) && poleIds.has(s.b)).toBe(true);
  ids('landscape', r.landscape);
  for (const item of r.landscape) expect(OWNER.at(item)).toBe(key);
  ids('barrier', r.barriers);
  for (const w of r.barriers) expect(OWNER.at(w.points[0]!)).toBe(key);
  for (const dab of r.paint) expect(OWNER.at(dab)).toBe(key);
  for (const t of [...r.trees, ...r.elements]) expect(OWNER.at(t as Place)).toBe(key);
}

describe('a tile of the streamed world, built alone', () => {
  const [i, j] = coolPair();
  const left = buildStreamTile(options, i, j);
  const right = buildStreamTile(options, i + 1, j);

  it('owns its records, ids in its range, every reference inside the tile', () => {
    checkTile(left, i, j);
    checkTile(right, i + 1, j);
    expect(left.nodes.length).toBeGreaterThan(0);
    expect(left.segments.length).toBeGreaterThan(0);
    expect(left.lots.length).toBeGreaterThan(0);
  });

  it('names the shared edge\'s nodes alike from both tiles, and no road is both tiles\'', () => {
    const line = (i + 1) * TILE;
    const all = (r: TileRecords): TileRecords['nodes'] => [...r.nodes, ...r.borrowedNodes];
    // The right tile owns the edge (its low edge); the left one's roads end on it as borrowed nodes.
    const owned = new Map(right.nodes.filter((n) => n.x === line).map((n) => [n.id, n]));
    const borrowed = left.borrowedNodes.filter((n) => n.x === line);
    expect(borrowed.length).toBeGreaterThan(0);
    for (const n of borrowed) {
      const there = owned.get(n.id);
      expect(there, `the left tile borrows ${n.id} at (${n.x}, ${n.y}), the right tile has no such node`).toBeDefined();
      expect([there!.x, there!.y]).toEqual([n.x, n.y]);
    }
    // One place, one id: wherever both tiles hold a node at the same place, it is the same id.
    const atLeft = new Map(all(left).map((n) => [`${n.x},${n.y}`, n.id]));
    let shared = 0;
    for (const n of all(right)) {
      const id = atLeft.get(`${n.x},${n.y}`);
      if (id === undefined) continue;
      expect(id).toBe(n.id);
      shared++;
    }
    expect(shared).toBeGreaterThanOrEqual(borrowed.length);
    // No road in both: by its two ends' ids, which name the same places in both tiles.
    const roads = new Set(left.segments.map((s) => pairKey(s.a, s.b)));
    for (const s of right.segments) expect(roads.has(pairKey(s.a, s.b)), `road ${s.a}-${s.b} in both tiles`).toBe(false);
  });

  it("builds a tile at the map's far corner, closed by its edge avenues inside the map, and nothing past the map's edge", () => {
    const far = buildStreamTile(options, 4, -5);
    checkTile(far, 4, -5);
    expect(far.nodes.length).toBeGreaterThan(0);
    expect(far.segments.length).toBeGreaterThan(0);
    // The east and south edges closed by an avenue `EDGE_INSET` inside the map; no node, nor a street's stub, past it.
    const inside = MAP_HALF - EDGE_INSET;
    const at = new Map([...far.nodes, ...far.borrowedNodes].map((n) => [n.id, n]));
    for (const n of at.values()) {
      expect(Math.abs(n.x), `node at x ${n.x}`).toBeLessThanOrEqual(inside + 1e-6);
      expect(Math.abs(n.y), `node at y ${n.y}`).toBeLessThanOrEqual(inside + 1e-6);
    }
    const along = (pick: (n: { x: number; y: number }) => number, line: number): boolean =>
      far.segments.some((sg) => { const a = at.get(sg.a), b = at.get(sg.b); return !!a && !!b && Math.abs(pick(a) - line) < 1e-6 && Math.abs(pick(b) - line) < 1e-6; });
    expect(along((n) => n.x, inside), 'the east edge avenue').toBe(true);
    expect(along((n) => n.y, -inside), 'the south edge avenue').toBe(true);
    const past = buildStreamTile(options, 40, -37);
    expect(past.nodes).toEqual([]);
    expect(past.segments).toEqual([]);
  }, 10_000);

  it('builds the same tile the same again, in the job worker too', () => {
    const posted: unknown[] = [];
    const scope: JobScope = { onmessage: null, postMessage: (message) => { posted.push(message); } };
    serve(scope);
    scope.onmessage!({ data: { stream: true, options, i, j } satisfies StreamTileAsk } as MessageEvent);
    expect(posted).toHaveLength(1);
    const answer = posted[0] as StreamTileAnswer;
    expect('records' in answer).toBe(true);
    if (!('records' in answer)) return;
    expect(answer.key).toBe(tileKey(i, j));
    expect(JSON.stringify(answer.records)).toBe(JSON.stringify(left));
  }, 10_000);
});

/** WHAT A TILE'S MAKER KEEPS OF ITS FAR LEVELS (`cityTile.worker.ts` keepFar): baked from the tile just made, under the key and version the page's level-0 job asks, so that job finds them and nothing reads the tile back nor grows its buildings again to bake them (the opening's two hundred far jobs, 2026-10-16). */
describe("a tile's far levels kept where it is made", () => {
  const [i, j] = coolPair();
  const pair = buildStreamTilePair(options, i, j);
  const version = 7;
  const memory = (): FarCache & FarRoadCache => {
    const kept = new Map<string, unknown>();
    return { ready: async () => true, get: async (key) => kept.get(key), put: async (key, value) => { kept.set(key, value); } };
  };
  const env = { ground: null, naturalIsGround: true };
  const prefix = 'test:far:';

  it("the buildings' level 0 is found by the page's job, its masses those of the tile's buildings", async () => {
    const cache = memory();
    const job: FarJob = { far: true, node: farKey(0, i, j), sig: String(version), want: true, prefix };
    // Not kept: the job (no records, no store) can only ask the page for them.
    expect((await runFarJob(job, cache)).kind).toBe('farRecords');
    expect(await keepTileFar({ ...pair.full, version }, version, env, prefix, cache)).toBe(true);
    const reply = await runFarJob(job, cache);
    expect(reply.kind).toBe('far');
    if (reply.kind !== 'far') return;
    const masses = bakeTileMasses(pair.records, TILE_DETAIL, undefined, undefined, tileSquare(i, j));
    const mass = reply.mass as CellMass | null;
    expect(mass?.index.length).toBe(masses?.index.length);
    expect(mass?.position).toEqual(masses?.position);
    // Another version is not this one's: asked again.
    expect((await runFarJob({ ...job, sig: String(version + 1) }, cache)).kind).toBe('farRecords');
  }, 10_000);

  it("the roads' level 0 is baked by the page's job from the tile's roads, the mesh they bake to", async () => {
    const cache = memory();
    const job: FarRoadJob = { node: farKey(0, i, j), k: 0, i, j, sig: String(version), want: true, prefix };
    // No records and no store: the page is asked for them.
    expect((await runFarRoadJob(job, cache)).kind).toBe('farRecords');
    const reply = await runFarRoadJob({ ...job, records: tileRoads(pair.records), around: [], aroundRecords: [] }, cache);
    expect(reply.kind).toBe('far');
    if (reply.kind !== 'far') return;
    expect(reply.payload).toEqual(bakeTileRoads(tileRoads(pair.records)));
    // Kept: asked again at its version, nothing read.
    expect((await runFarRoadJob(job, cache)).kind).toBe('far');
  }, 10_000);

  it('keeps nothing where the far tree keeps nothing', async () => {
    const cache = memory();
    expect(await keepTileFar(pair.full, version, env, null, cache)).toBe(false);
  });
});
