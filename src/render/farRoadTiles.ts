import { MeshoptSimplifier } from 'meshoptimizer';
import { Digest } from '@core/digest';
import { type MultiPoly, difference, intersection, union } from '@core/clipper';
import type { NodeId, SegmentId } from '@world/ids';
import { Network, type SegmentRibbon } from '@world/network';
import { FOOTWAY_RISE, Level, ROAD_TYPES, halfWidth, roadType } from '@world/roadTypes';
import { EDGE_INSET, MAP_HALF, MAP_TILES, type WholeMapOptions, gatesOf, mapLine, planWholeMap } from '@world/cityGen/wholeMap';
import type { SurfaceLevel } from '@world/roadTypes';
import { levelRingsOf } from '@world/surfaces';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';
import { derivedCacheOpen, keepDerivedDurably, readDerived } from './derivedCache';
import { surfaceShape } from './mesh/tileShape';
import { PLAN_SIG, farNode, planKey, readStored } from './buildings/farGrid';
import { medianOf } from './roadSurfaceRings';
import { ASPHALT_REFERENCE, CARRIAGEWAY_COLOUR, FOOTWAY_TINT } from './roadTones';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';
import { type NearRoadMesh, type NearRoadWant, type NearTileRoads, nearRoadBuffers, nearRoadDoc, runNearRoadJob } from './nearRoadTiles';
import { TILE as SURFACE_TILE, TILE_ORIGIN as SURFACE_ORIGIN } from './roadSurfaceInputs';

/** THE ROADS FAR FROM THE CAMERA, BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"): nothing of their records on the page */
/** A tile's roads built alone (its segments and borrowed ends, as `editor/wholeMapTile.ts` builds a tile), drawn flat on the ground as one mesh: carriageways, kerbs, footways and medians, each the colour its near material reads from afar */
/** Above the tiles, a quadtree (`farTree.ts`): each node its quarters' meshes merged and simplified to its level's error (meshoptimizer, as `mesh/roadLodPure.ts`) */

/** A far road mesh: compact vertices (CLAUDE.md "Cidade": int16 position per tile, RGBA8 colour) */
export interface FarRoadMesh {
  /** Plan x and y from the origin, times `q` (int16; three's z is -y). */
  readonly xz: Int16Array;
  /** Height of each vertex, m. */
  readonly height: Float32Array;
  /** Its normal in three's axes (x, up, -y), signed bytes; the fourth unused. */
  readonly normal: Int8Array;
  /** Its colour, sRGB bytes (the shader makes it linear), opaque. */
  readonly color: Uint8Array;
  readonly index: Uint16Array | Uint32Array;
  /** The origin on the plan, and the steps a metre the plan is told in. */
  readonly ox: number;
  readonly oy: number;
  readonly q: number;
  /** Plan box and heights: x0, y0, x1, y1, lowest, highest. */
  readonly bounds: Float64Array;
  /** What it leaves out of the roads, m. */
  readonly error: number;
}

/** The finest steps a metre a mesh is told in: 1.6 cm (a mesh wider than int16 at that step takes coarser ones). */
const Q_MOST = 64;
/** Edges of the ground's triangles before simplification, m: the roads follow the ground's corners at this spacing. */
const MAX_EDGE = m(24);
/** Lift over the ground: the carriageway a hair over the land, footways, kerbs and islands their kerb's rise. */
const CARRIAGEWAY_LIFT = m(0.05);
const RAISED_LIFT = FOOTWAY_RISE;
/** What a tile's mesh leaves out of its roads, m; a level above leaves out twice its children's (`farLevelError`). */
const TILE_ERROR = m(0.25);
const LEVEL_ERROR = m(0.5);

/** What a node of level `k` leaves out of the roads, m. */
export const farLevelError = (k: number): number => (k === 0 ? TILE_ERROR : LEVEL_ERROR * 2 ** k);

// ---- the colours from afar: each near material's texture's mean, times the tint it is drawn with

/** sRGB to linear and back (IEC 61966-2-1, as three's `SRGBToLinear`). */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexLinear = (hex: number): [number, number, number] => [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)];

/** THE MEAN LINEAR ALBEDO OF EACH BAKED STREET TEXTURE (`bake/roadRecipes.ts`), every texel as stored (sRGB bytes) and read (linear). DO NOT work them out in every worker from the recipes (four textures shaded a texel in seven, again per worker of the far roads, plan R12): constants, held to the recipes by `tests/render/farRoads.spec.ts` (a recipe changed fails it, with the new values). */
export const STREET_MEANS: Readonly<Record<'asphalt' | 'footway' | 'kerb' | 'verge', readonly [number, number, number]>> = {
  asphalt: [0.040666, 0.041456, 0.044698],
  footway: [0.210044, 0.208119, 0.195658],
  kerb: [0.338651, 0.331236, 0.316671],
  verge: [0.029413, 0.070144, 0.010057],
};

/** Each surface's colour from afar, linear. */
interface FarRoadTones {
  /** The carriageway by road class (`ROAD_TYPES`), and by what it is paved with. */
  readonly classes: readonly (readonly [number, number, number])[];
  readonly paving: Readonly<Record<string, readonly [number, number, number]>>;
  readonly kerb: readonly [number, number, number];
  readonly footway: Readonly<Record<string, readonly [number, number, number]>>;
  /** A median's planting (the verge's grass) and its paving. */
  readonly planting: readonly [number, number, number];
}

function makeTones(): FarRoadTones {
  const { asphalt, footway, kerb, verge } = STREET_MEANS;
  const reference = hexLinear(ASPHALT_REFERENCE);
  // As `roadSurfaces.ts` `againstReference`: the class's colour over the reference, channel by channel, times the texture.
  const over = (hex: number): [number, number, number] => {
    const c = hexLinear(hex);
    return [asphalt[0] * c[0] / reference[0], asphalt[1] * c[1] / reference[1], asphalt[2] * c[2] / reference[2]];
  };
  const tinted = (t: readonly [number, number, number]): [number, number, number] => [footway[0] * t[0], footway[1] * t[1], footway[2] * t[2]];
  return {
    classes: ROAD_TYPES.map((type) => over(Number.parseInt(type.color.slice(1), 16))),
    paving: Object.fromEntries(Object.entries(CARRIAGEWAY_COLOUR).map(([name, hex]) => [name, over(hex)])),
    kerb: [...kerb],
    footway: Object.fromEntries(Object.entries(FOOTWAY_TINT).map(([name, tint]) => [name, tinted(tint)])),
    planting: [...verge],
  };
}

/** The near materials' means made once, at load: constants of constants (`STREET_MEANS`, the road classes' colours). */
const FAR_ROAD_TONES: FarRoadTones = makeTones();

/** The near materials' means (`materials.ts`: the texture times the vertex tint, the close-up layer gone from afar, `detailLayer.ts`). */
export function farRoadTones(): FarRoadTones {
  return FAR_ROAD_TONES;
}

/** A linear colour as the mesh's sRGB bytes. */
const srgbBytes = (c: readonly [number, number, number]): [number, number, number] =>
  [Math.round(toSrgb(Math.min(1, c[0])) * 255), Math.round(toSrgb(Math.min(1, c[1])) * 255), Math.round(toSrgb(Math.min(1, c[2])) * 255)];

// ---- a tile's roads as one mesh

/** One surface of the tile, its rings before they are merged: drawn in `order` (a lower order covers a higher one where they overlap). */
interface Band {
  readonly order: number;
  readonly tone: readonly [number, number, number];
  readonly lift: number;
  readonly rings: MultiPoly;
}

/** A mesh being built: plan x, y, height, normal, sRGB colour per vertex; triangles counter-clockwise from above. */
class Builder {
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly h: number[] = [];
  readonly n: number[] = [];
  readonly c: number[] = [];
  readonly tris: number[] = [];

  get vertices(): number {
    return this.x.length;
  }
}

/** The ground's height and normal (three's axes) at a point: by its slope across 2 m either way. */
function groundNormal(groundAt: (x: number, y: number) => number, x: number, y: number, out: number[]): void {
  const d = m(2);
  const hx = (groundAt(x + d, y) - groundAt(x - d, y)) / (2 * d);
  const hy = (groundAt(x, y + d) - groundAt(x, y - d)) / (2 * d);
  // The surface (x, h, -y): its normal is (-dh/dx, 1, dh/dy).
  const len = Math.hypot(hx, 1, hy);
  out.push(-hx / len, 1 / len, hy / len);
}

/** A band's polygons triangulated (`mesh/tileShape.ts`, refined to `maxEdge`), its vertices shared within it. */
function emitBand(out: Builder, shape: MultiPoly, band: Band, groundAt: (x: number, y: number) => number, maxEdge = MAX_EDGE): void {
  if (!shape.length) return;
  const [r, g, b] = srgbBytes(band.tone);
  const welded = new Map<string, number>();
  for (const piece of surfaceShape(shape, maxEdge, false).pieces) {
    const at: number[] = [];
    for (let v = 0; v < piece.xy.length; v += 2) {
      const x = piece.xy[v]!, y = piece.xy[v + 1]!;
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      let index = welded.get(key);
      if (index === undefined) {
        index = out.vertices;
        welded.set(key, index);
        out.x.push(x); out.y.push(y); out.h.push(groundAt(x, y) + band.lift);
        groundNormal(groundAt, x, y, out.n);
        out.c.push(r, g, b);
      }
      at.push(index);
    }
    for (let t = 0; t < piece.tris.length; t += 3) {
      const a = at[piece.tris[t]!]!, p = at[piece.tris[t + 1]!]!, q = at[piece.tris[t + 2]!]!;
      if (a === p || p === q || q === a) continue;
      // Counter-clockwise on the plan is facing up in three's axes (plan y is -z).
      const area = (out.x[p]! - out.x[a]!) * (out.y[q]! - out.y[a]!) - (out.y[p]! - out.y[a]!) * (out.x[q]! - out.x[a]!);
      if (area === 0) continue;
      if (area > 0) out.tris.push(a, p, q); else out.tris.push(a, q, p);
    }
  }
}

/** @rebuild Every road a tile's bake reads (`nearRoadDoc`: its own and its neighbours' within reach), never the map's. THE BANDS OF A TILE'S ROADS: each road's carriageway (its class's or its paving's tone), kerb, footway (its material's) and median; each junction, its plate in its widest road's tone */
function tileBands(net: Network): Band[] {
  const tones = farRoadTones();
  const bands = new Map<string, { order: number; tone: readonly [number, number, number]; lift: number; rings: MultiPoly }>();
  const add = (key: string, order: number, tone: readonly [number, number, number], lift: number, rings: MultiPoly): void => {
    if (!rings.length) return;
    let band = bands.get(key);
    if (!band) bands.set(key, band = { order, tone, lift, rings: [] });
    for (const ring of rings) band.rings.push(ring);
  };
  const structureOf = (id: SegmentId): string => net.doc.segment(id)?.structure ?? 'ground';
  // A tunnel is under the ground: never seen from afar.
  const seen = (id: SegmentId): boolean => structureOf(id) !== 'tunnel';
  const carriageway = (ribbon: SegmentRibbon): { key: string; tone: readonly [number, number, number] } => {
    const paving = ribbon.road.materials?.carriageway;
    if (paving && paving !== 'asphalt') return { key: `c:${paving}`, tone: tones.paving[paving]! };
    const type = Math.min(Math.max(ribbon.typeIndex, 0), tones.classes.length - 1);
    return { key: `c:${type}`, tone: tones.classes[type]! };
  };
  for (const ribbon of net.ribbons.values()) {
    if (!seen(ribbon.id)) continue;
    const road = carriageway(ribbon);
    add(road.key, 2, road.tone, CARRIAGEWAY_LIFT, levelRingsOf(net, Level.Asphalt, [ribbon], []));
    add('k', 3, tones.kerb, RAISED_LIFT, levelRingsOf(net, Level.Curb, [ribbon], []));
    const left = ribbon.road.materials?.footwayLeft ?? 'pavers', right = ribbon.road.materials?.footwayRight ?? 'pavers';
    // One tone a road: its sides' material when they agree, the pavers when not.
    const footway = left === right ? left : 'pavers';
    add(`f:${footway}`, 4, tones.footway[footway]!, RAISED_LIFT, levelRingsOf(net, Level.Sidewalk, [ribbon], []));
    const median = medianOf(net, ribbon);
    if (median) {
      add(median.paved ? 'm:paved' : 'm:planting', 0, median.paved ? tones.footway['concrete']! : tones.planting, RAISED_LIFT, [median.inner]);
      add('mk', 1, tones.kerb, RAISED_LIFT, [median.kerb]);
    }
  }
  // Every junction read: the tile's share cuts what is not its own (`tileShare`), and every node within the share's reach is read whole (`nearRoadDoc`).
  for (const [node, byLevel] of net.junctions) {
    let widest: SegmentRibbon | null = null;
    for (const id of net.doc.node(node)?.incident ?? []) {
      const ribbon = net.ribbons.get(id);
      if (ribbon && seen(id) && (!widest || ribbon.road.width > widest.road.width)) widest = ribbon;
    }
    if (!widest) continue;
    const road = carriageway(widest);
    const entry: [NodeId, typeof byLevel][] = [[node, byLevel]];
    add(road.key, 2, road.tone, CARRIAGEWAY_LIFT, levelRingsOf(net, Level.Asphalt, [], entry, seen));
    // A taper where a road carries on at another width (`roadSurfaceInputs.ts` `placeNode`).
    const plate = byLevel.get(Level.Asphalt);
    if (net.transitions.has(node) && plate && !plate.ring.isEmpty) add(road.key, 2, road.tone, CARRIAGEWAY_LIFT, [[plate.ring.flatten().map((p) => [p.x, p.y])]]);
    add('k', 3, tones.kerb, RAISED_LIFT, levelRingsOf(net, Level.Curb, [], entry, seen));
    add('f:pavers', 4, tones.footway['pavers']!, RAISED_LIFT, levelRingsOf(net, Level.Sidewalk, [], entry, seen));
  }
  return [...bands.values()].sort((a, b) => a.order - b.order);
}

/** What a far road bake reads of a tile: its key, its nodes, the ends it borrows and its roads (the store's `roads` part, `tileReader.ts`). */
export type TileRoads = Pick<TileRecords, 'key' | 'nodes' | 'borrowedNodes' | 'segments'>;

/** DO NOT post a tile's records whole to a road bake (its buildings above all, which no road reads): its roads alone. */
export const tileRoads = (records: TileRoads): TileRoads =>
  ({ key: records.key, nodes: records.nodes, borrowedNodes: records.borrowedNodes, segments: records.segments });

/** THE SAME SHARE OF THE GROUND AS THE TILE'S NEAR LEVEL (`nearRoadTiles.ts`: a 76.8 m surface tile is the 1 km tile's its centre lies in): its square snapped to the surface tiles, [x0, y0, x1, y1]. DO NOT share a tile's roads by who owns them: a border avenue was the north tile's far level and the south tile's near level, and with one tile at each level neither drew it (cars on the grass after a jump, 2026-10-18). */
export function tileShare(key: number): readonly [number, number, number, number] {
  const { i, j } = tileOfKey(key);
  const first = (edge: number): number => SURFACE_ORIGIN + Math.ceil((edge - SURFACE_ORIGIN) / SURFACE_TILE - 0.5) * SURFACE_TILE;
  return [first(i * TILE), first(j * TILE), first((i + 1) * TILE), first((j + 1) * TILE)];
}

/** The roads a tile's far bake reads, as its near bake reads them (`nearRoadDoc`): its own, its neighbours' that reach it, and those meeting their ends. */
export function tileNetwork(records: TileRoads, around: readonly TileRoads[] = []): Network {
  const asNear = (t: TileRoads): NearTileRoads => ({ key: t.key, nodes: t.nodes, borrowedNodes: t.borrowedNodes, segments: t.segments, gates: [] });
  const net = new Network(nearRoadDoc(asNear(records), around.map(asNear), 'classic'));
  net.rebuild();
  return net;
}

const FLAT = (): number => 0;

/** A TILE'S FAR ROADS: every road band its share of the ground holds (`tileShare`), read from it and its neighbours (`around`, the eight round it), as one mesh simplified to a tile's error; null with no road seen */
export function bakeTileRoads(records: TileRoads, around: readonly TileRoads[] = [], groundAt: (x: number, y: number) => number = FLAT): FarRoadMesh | null {
  if (records.segments.length === 0 && around.every((t) => t.segments.length === 0)) return null;
  const net = tileNetwork(records, around);
  const [sx0, sy0, sx1, sy1] = tileShare(records.key);
  const share: MultiPoly = [[[[sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1]]]];
  const out = new Builder();
  // Each band where none before it lies (the carriageway over the kerb over the footway, as `world/surfaces.ts` `bands` cuts them).
  let covered: MultiPoly = [];
  for (const band of tileBands(net)) {
    const own = intersection(union(band.rings), share);
    if (!own.length) continue;
    emitBand(out, covered.length ? difference(own, covered) : own, band, groundAt);
    covered = union(covered, own);
  }
  const { i, j } = tileOfKey(records.key);
  return finish(out, (i + 0.5) * TILE, (j + 0.5) * TILE, TILE_ERROR, true);
}

// ---- the roads of the tiles not made yet, from the generator's plan (as `buildings/farPlan.ts` draws their buildings)

/** The classes the plan's roads are laid as (`cityGen/plan.ts` LEVEL_ROAD): a border avenue and an avenue gate's street, a collector gate's street. */
const AVENUE = Math.max(0, ROAD_TYPES.findIndex((t) => t.id === 'avenue'));
const COLLECTOR = Math.max(0, ROAD_TYPES.findIndex((t) => t.id === 'urban'));

/** A straight road of the plan: across x (`along` 'y': at x = `at`, from `from` to `to` in y) or across y; its class. */
interface PlanLine { readonly along: 'x' | 'y'; readonly at: number; readonly from: number; readonly to: number; readonly type: number }

/** A line's band at a level of the road (`halfWidth`): a rectangle on the plan. */
function lineRect(line: PlanLine, level: SurfaceLevel): MultiPoly {
  const half = halfWidth(roadType(line.type), level);
  const [x0, y0, x1, y1] = line.along === 'y'
    ? [line.at - half, line.from, line.at + half, line.to]
    : [line.from, line.at - half, line.to, line.at + half];
  return [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
}

/** THE PLAN'S ROADS OF A NODE NO TILE IS MADE UNDER YET (`farTree.ts` `PLAN_SIG`): every tile's border avenues on the edges it owns and its gates' streets straight across it (`cityGen/tile.ts`), the collectors only at a tile's level; none where an avenue is narrower than the level leaves out. Baked once per world (the plan never changes); drawn until the tiles come (refinement by replacement), never a hole. */
export function bakePlanRoads(plan: WholeMapOptions, k: number, i: number, j: number, groundAt: (x: number, y: number) => number = FLAT): FarRoadMesh | null {
  const error = farLevelError(k);
  if (error > 2 * halfWidth(roadType(AVENUE), Level.Asphalt)) return null;
  const side = TILE * 2 ** k, x0 = i * side, y0 = j * side, x1 = x0 + side, y1 = y0 + side;
  // Nothing past the map's edge (`wholeMap.ts` MAP_HALF): the node clipped to it, none outside.
  if (x0 >= MAP_HALF || x1 <= -MAP_HALF || y0 >= MAP_HALF || y1 <= -MAP_HALF) return null;
  // Clipped to the avenues closing the map, `EDGE_INSET` inside its edge (`mapLine`).
  const inside = MAP_HALF - EDGE_INSET;
  const mx0 = Math.max(x0, -inside), my0 = Math.max(y0, -inside), mx1 = Math.min(x1, inside), my1 = Math.min(y1, inside);
  const first = { i: i * 2 ** k, j: j * 2 ** k }, count = 2 ** k;
  const lines: PlanLine[] = [];
  const map = k === 0 ? planWholeMap(plan) : null;
  // A tile's low borders as its generator lays them (`tileOnMap`): only a tile on the map has them.
  const onMap = (t: number): boolean => t >= -MAP_TILES / 2 && t < MAP_TILES / 2;
  for (let c = 0; c < count; c++) {
    const ci = first.i + c, rj = first.j + c;
    if (onMap(ci)) lines.push({ along: 'y', at: mapLine(ci), from: my0, to: my1, type: AVENUE });
    if (onMap(rj)) lines.push({ along: 'x', at: mapLine(rj), from: mx0, to: mx1, type: AVENUE });
    // A tile's collectors too, unless it is the countryside (its avenue gates' streets alone, `tile.ts`).
    const rural = map !== null && map.tile(first.i, first.j).style === 'rural';
    for (const gate of gatesOf(plan.seed, 1, ci)) {
      if (gate.level === 0 || (map !== null && !rural)) lines.push({ along: 'y', at: gate.at, from: my0, to: my1, type: gate.level === 0 ? AVENUE : COLLECTOR });
    }
    for (const gate of gatesOf(plan.seed, 0, rj)) {
      if (gate.level === 0 || (map !== null && !rural)) lines.push({ along: 'x', at: gate.at, from: mx0, to: mx1, type: gate.level === 0 ? AVENUE : COLLECTOR });
    }
  }
  // The map's east and north edges: the avenues closing it, which no tile's low border lays.
  if (x1 >= inside) lines.push({ along: 'y', at: inside, from: my0, to: my1, type: AVENUE });
  if (y1 >= inside) lines.push({ along: 'x', at: inside, from: mx0, to: mx1, type: AVENUE });
  const tones = farRoadTones();
  const out = new Builder();
  const maxEdge = MAX_EDGE * 2 ** k;
  const carriageway = union(lines.flatMap((line) => lineRect(line, Level.Asphalt)));
  emitBand(out, carriageway, { order: 2, tone: tones.classes[AVENUE]!, lift: CARRIAGEWAY_LIFT, rings: carriageway }, groundAt, maxEdge);
  // The footways at a tile's and a plate's levels, beside the carriageways (further out, under a pixel).
  if (k <= 1) {
    const footway = difference(union(lines.flatMap((line) => lineRect(line, Level.Sidewalk))), carriageway);
    emitBand(out, footway, { order: 4, tone: tones.footway['pavers']!, lift: RAISED_LIFT, rings: footway }, groundAt, maxEdge);
  }
  return finish(out, (x0 + x1) / 2, (y0 + y1) / 2, error);
}

/** Several meshes as one, simplified to `error`, about the origin (`ox`, `oy`); null when nothing is left. */
function mergeRoads(parts: readonly (FarRoadMesh | null)[], ox: number, oy: number, error: number): FarRoadMesh | null {
  const out = new Builder();
  for (const part of parts) {
    if (!part) continue;
    const base = out.vertices;
    const count = part.height.length;
    for (let v = 0; v < count; v++) {
      out.x.push(part.ox + part.xz[v * 2]! / part.q);
      out.y.push(part.oy + part.xz[v * 2 + 1]! / part.q);
      out.h.push(part.height[v]!);
      out.n.push(part.normal[v * 4]! / 127, part.normal[v * 4 + 1]! / 127, part.normal[v * 4 + 2]! / 127);
      out.c.push(part.color[v * 4]!, part.color[v * 4 + 1]!, part.color[v * 4 + 2]!);
    }
    for (let t = 0; t < part.index.length; t++) out.tris.push(base + part.index[t]!);
  }
  return finish(out, ox, oy, error);
}

/** The most vertices one call of the simplifier is given: its WebAssembly memory grows to the largest call's needs and never shrinks (WebAssembly `memory.grow`), in every worker that bakes a level. */
export const SIMPLIFY_VERTICES = 1 << 15;

/**
 * `index` simplified to `error` (absolute, tiny islands pruned) in batches of whole pieces (triangles joined by their vertices) of at most
 * `SIMPLIFY_VERTICES` vertices each. DO NOT give the simplifier a level's every vertex at once: its quarters are never welded (`mergeRoads`
 * puts their vertices side by side), so a batch of whole pieces simplifies as they would together, and a level of 16 x 16 tiles grew each
 * baking worker's WebAssembly memory by ~90 MB for good. A piece is never cut: no border made where there was none.
 */
export function simplifyInParts(index: Uint32Array, position: Float32Array, count: number, error: number, lock = false): Uint32Array {
  const flags: ('ErrorAbsolute' | 'Prune' | 'LockBorder')[] = lock ? ['ErrorAbsolute', 'Prune', 'LockBorder'] : ['ErrorAbsolute', 'Prune'];
  if (count <= SIMPLIFY_VERTICES) return MeshoptSimplifier.simplify(index, position, 3, 0, error, flags)[0];
  // The pieces (union-find over each triangle's corners), numbered in the order their first triangle comes.
  const parent = new Int32Array(count);
  for (let v = 0; v < count; v++) parent[v] = v;
  const root = (v: number): number => {
    while (parent[v] !== v) { parent[v] = parent[parent[v]!]!; v = parent[v]!; }
    return v;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = root(index[t]!), b = root(index[t + 1]!), c = root(index[t + 2]!);
    parent[b] = a; parent[root(c)] = a;
  }
  const pieceOf = new Int32Array(count).fill(-1);
  const pieceVertices: number[] = [];
  const pieceTriangles: number[] = [];
  const pieceAt = new Int32Array(index.length / 3);
  for (let t = 0; t < index.length; t += 3) {
    const r = root(index[t]!);
    if (pieceOf[r]! < 0) { pieceOf[r] = pieceVertices.length; pieceVertices.push(0); pieceTriangles.push(0); }
    pieceAt[t / 3] = pieceOf[r]!;
    pieceTriangles[pieceOf[r]!]!++;
  }
  for (let v = 0; v < count; v++) { const p = pieceOf[root(v)]!; if (p >= 0) pieceVertices[p]!++; }
  // Each piece's triangles together, the pieces in order (a counting sort).
  const start = new Int32Array(pieceTriangles.length + 1);
  for (let p = 0; p < pieceTriangles.length; p++) start[p + 1] = start[p]! + pieceTriangles[p]!;
  const order = new Int32Array(index.length / 3);
  const fill = start.slice(0, pieceTriangles.length);
  for (let t = 0; t < pieceAt.length; t++) order[fill[pieceAt[t]!]!++] = t;
  const local = new Int32Array(count).fill(-1);
  const kept: Uint32Array[] = [];
  let total = 0;
  for (let first = 0; first < pieceTriangles.length;) {
    // As many whole pieces as fit the batch (a piece larger than it alone).
    let last = first, vertices = pieceVertices[first]!;
    while (last + 1 < pieceTriangles.length && vertices + pieceVertices[last + 1]! <= SIMPLIFY_VERTICES) vertices += pieceVertices[++last]!;
    const from = start[first]!, to = start[last + 1]!;
    const batchIndex = new Uint32Array((to - from) * 3);
    const batchPosition = new Float32Array(vertices * 3);
    const global = new Uint32Array(vertices);
    let used = 0;
    for (let n = from; n < to; n++) {
      const t = order[n]! * 3;
      for (let c = 0; c < 3; c++) {
        const v = index[t + c]!;
        if (local[v]! < 0) {
          local[v] = used; global[used] = v;
          batchPosition[used * 3] = position[v * 3]!; batchPosition[used * 3 + 1] = position[v * 3 + 1]!; batchPosition[used * 3 + 2] = position[v * 3 + 2]!;
          used++;
        }
        batchIndex[(n - from) * 3 + c] = local[v]!;
      }
    }
    const [simpler] = MeshoptSimplifier.simplify(batchIndex, batchPosition.subarray(0, used * 3), 3, 0, error, flags);
    for (let i = 0; i < simpler.length; i++) simpler[i] = global[simpler[i]!]!;
    kept.push(simpler);
    total += simpler.length;
    first = last + 1;
  }
  const out = new Uint32Array(total);
  let at = 0;
  for (const part of kept) { out.set(part, at); at += part.length; }
  return out;
}

/** DO NOT draw a level whole: simplified to its error (meshoptimizer `simplify`, absolute error, tiny islands pruned, as `mesh/roadLodPure.ts`), its vertices compacted; `lock`, each band's outline kept where it is (a tile's level). */
function finish(out: Builder, ox: number, oy: number, error: number, lock = false): FarRoadMesh | null {
  const count = out.vertices;
  if (out.tris.length === 0) return null;
  const position = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    position[v * 3] = out.x[v]! - ox; position[v * 3 + 1] = out.h[v]!; position[v * 3 + 2] = -(out.y[v]! - oy);
  }
  let kept: Uint32Array = Uint32Array.from(out.tris);
  // DO NOT simplify the bands together: the simplifier welds vertices by position, and a kerb's strip collapsed across the carriageway beside it, drawn over the asphalt 10 cm up (every far street light grey, 2026-10-18). Each colour alone.
  if (MeshoptSimplifier.supported) {
    const byColour = new Map<number, number[]>();
    for (let t = 0; t < kept.length; t += 3) {
      const v = kept[t]!;
      const colour = (out.c[v * 3]! << 16) | (out.c[v * 3 + 1]! << 8) | out.c[v * 3 + 2]!;
      let list = byColour.get(colour);
      if (!list) byColour.set(colour, list = []);
      list.push(kept[t]!, kept[t + 1]!, kept[t + 2]!);
    }
    const parts = [...byColour.values()].map((list) => simplifyInParts(Uint32Array.from(list), position, count, error, lock));
    kept = new Uint32Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) { kept.set(part, at); at += part.length; }
  }
  if (kept.length === 0) return null;
  const remap = new Int32Array(count).fill(-1);
  let used = 0;
  for (let t = 0; t < kept.length; t++) if (remap[kept[t]!]! < 0) remap[kept[t]!] = used++;
  let reach = 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, h0 = Infinity, h1 = -Infinity;
  for (let v = 0; v < count; v++) {
    if (remap[v]! < 0) continue;
    const x = out.x[v]!, y = out.y[v]!, h = out.h[v]!;
    reach = Math.max(reach, Math.abs(x - ox), Math.abs(y - oy));
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    h0 = Math.min(h0, h); h1 = Math.max(h1, h);
  }
  // As fine as int16 holds the farthest vertex.
  const q = Math.min(Q_MOST, 32_767 / reach);
  const xz = new Int16Array(used * 2), height = new Float32Array(used), normal = new Int8Array(used * 4), color = new Uint8Array(used * 4);
  for (let v = 0; v < count; v++) {
    const at = remap[v]!;
    if (at < 0) continue;
    xz[at * 2] = Math.round((out.x[v]! - ox) * q);
    xz[at * 2 + 1] = Math.round((out.y[v]! - oy) * q);
    height[at] = out.h[v]!;
    for (let k = 0; k < 3; k++) normal[at * 4 + k] = Math.round(Math.max(-1, Math.min(1, out.n[v * 3 + k]!)) * 127);
    for (let k = 0; k < 3; k++) color[at * 4 + k] = out.c[v * 3 + k]!;
    color[at * 4 + 3] = 255;
  }
  const index = used > 0xffff ? new Uint32Array(kept.length) : new Uint16Array(kept.length);
  for (let t = 0; t < kept.length; t++) index[t] = remap[kept[t]!]!;
  return { xz, height, normal, color, index, ox, oy, q, bounds: Float64Array.of(x0, y0, x1, y1, h0, h1), error };
}

/** Every buffer of a mesh: handed over, not copied (MDN, `postMessage` transfer). */
const farRoadBuffers = (mesh: FarRoadMesh): ArrayBuffer[] =>
  [mesh.xz, mesh.height, mesh.normal, mesh.color, mesh.index, mesh.bounds].map((a) => a.buffer as ArrayBuffer);

// ---- the jobs: a node's mesh from the cache, its tile's records or its children's bakes

/** Where bakes are kept by node (`derivedCache.ts` in the job workers; a map in tests). */
export interface FarRoadCache {
  ready(): Promise<boolean>;
  get(key: string): Promise<unknown>;
  /** Resolved once kept for good: a parent's job, maybe on another worker, reads it after. */
  put(key: string, value: unknown): Promise<void>;
}

/** The player's browser store, from the worker that bakes (IndexedDB is open to workers, MDN). */
export const derivedRoadCache: FarRoadCache = {
  ready: derivedCacheOpen,
  get: (key) => readDerived(key),
  put: async (key, value) => { await (await keepDerivedDurably(key, value)).committed; },
};


/** A far job (`farTree.ts` asks it, `farRoads.worker.ts` runs it) */
export interface FarRoadJob {
  /** The node's key, level, column and row (`buildings/farTiles.ts` `farKey`). */
  readonly node: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  /** The version of the tiles under it: what it is kept under. */
  readonly sig: string;
  /** Its mesh wanted back (to be drawn), or only baked and kept (for a parent). */
  readonly want: boolean;
  /** The cache's prefix (this build's fingerprint of this code); null: nothing kept, no level past the tiles. */
  readonly prefix: string | null;
  /** Its four quarters (level 1 and up), null where no tile is. */
  readonly children?: readonly ({ readonly key: string; readonly sig: string } | null)[];
  /** Level 0, once the cache said it did not have it and no worker reads the store (the desktop's): the tile's roads the page read (`tileRoads`). */
  readonly records?: TileRoads;
  /** Level 0: the store's map this worker reads the tile from itself (`core/storedTiles.ts`), in place of `records`. */
  readonly store?: string;
  /** Level 0: the tiles round it stored, read with it (`bakeTileRoads`), each at its version. */
  readonly around?: readonly { readonly key: number; readonly version: number }[];
  /** Level 0, with `records`: the roads of `around` the page read, in that order. */
  readonly aroundRecords?: readonly TileRoads[];
  /** The ground shared with the workers (`sharedGround.ts`); none: flat at 0. */
  readonly ground?: SharedGroundData | null;
  /** A tile's near level (`nearRoadTiles.ts`): what it reads besides the roads; its node is the tile's under level 0. */
  readonly near?: NearRoadWant;
  /** The world's generator options: a node or a quarter no tile is made under yet (`PLAN_SIG`) is baked from its plan (`bakePlanRoads`). */
  readonly plan?: WholeMapOptions;
}

export type FarRoadReply =
  /** Baked and kept: its mesh when wanted (null: no road seen under it); a tile's near level's (`nearRoadTiles.ts`) for a near job. */
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly payload: FarRoadMesh | NearRoadMesh | null }
  /** A tile not kept at that version and no store this worker reads: its roads wanted from the page. */
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  /** Children not kept at their versions: baked first. */
  | { readonly kind: 'farChildren'; readonly node: string; readonly sig: string; readonly missing: readonly string[] }
  /** Nothing can be kept here: no level past the tiles. */
  | { readonly kind: 'farNoCache'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** Every buffer of a reply. */
export const farRoadReplyBuffers = (reply: FarRoadReply): ArrayBuffer[] =>
  (reply.kind === 'far' && reply.payload ? ('near' in reply.payload ? nearRoadBuffers(reply.payload) : farRoadBuffers(reply.payload)) : []);

/** What a node keeps: the version of its tiles and its mesh; a tile's, the roads it read too (`content`). */
interface RoadEntry {
  readonly sig: string;
  readonly mesh: FarRoadMesh | null;
  readonly content?: string;
}

/** The roads a tile's far bake reads, digested: a neighbour written with the same roads (a building grown) bakes nothing again. */
function roadsContent(tiles: readonly TileRoads[]): string {
  const d = new Digest();
  for (const t of tiles) d.add(t.key).addPlain(t.nodes).addPlain(t.borrowedNodes).addPlain(t.segments);
  return d.value().toString(36);
}

/** DO NOT bake what is kept: a node is baked once per version of its tiles (kept under its key with that version), from its tile's records or its children's bakes, never from the page's document */
export async function runFarRoadJob(job: FarRoadJob, cache: FarRoadCache): Promise<FarRoadReply> {
  // A tile's near level: its own job, in the same service (the roads' code warm in the same workers).
  if (job.near) return runNearRoadJob({ ...job, near: job.near }, cache);
  const { node, sig, prefix, k, i, j } = job;
  // DO NOT simplify before the simplifier's WebAssembly is made (meshoptimizer README, `MeshoptSimplifier.ready`).
  await MeshoptSimplifier.ready;
  const keeps = prefix !== null && await cache.ready();
  const kept = async (key: string, version: string): Promise<RoadEntry | undefined> => {
    const entry = await cache.get(`${prefix}${key}`) as RoadEntry | undefined;
    return entry?.sig === version ? entry : undefined;
  };
  // A node's plan kept apart from its tiles' bake (`planKey`).
  let entry = keeps ? await kept(sig === PLAN_SIG ? planKey(node) : node, sig) : undefined;
  const ground = job.ground ? sharedGroundReaders(job.ground).groundAt : FLAT;
  // A node no tile is made under yet, or one standing in its plan until its tiles' bake comes: the plan's roads, baked once per world.
  if (sig === PLAN_SIG) {
    if (!job.plan) return { kind: 'farError', node, sig, message: `far road node ${node}: no tile and no plan` };
    if (!entry) {
      entry = { sig, mesh: bakePlanRoads(job.plan, k, i, j, ground) };
      if (keeps) await cache.put(`${prefix}${planKey(node)}`, entry);
    }
    return { kind: 'far', node, sig, payload: job.want ? entry.mesh : null };
  }
  if (k === 0) {
    if (!entry) {
      const records = job.records ?? await readStored(job.store, tileKey(i, j), 'roads');
      if (!records) return { kind: 'farRecords', node, sig };
      const keys = job.around ?? [];
      let around: TileRoads[];
      if (job.aroundRecords) around = [...job.aroundRecords];
      else {
        const read = await Promise.all(keys.map((t) => readStored(job.store, t.key, 'roads')));
        // The page read the tile itself and no worker reads the store: theirs from the page too.
        if (keys.length && read.some((r) => !r) && job.store === undefined) return { kind: 'farRecords', node, sig };
        around = read.flatMap((r) => (r ? [tileRoads(r)] : []));
      }
      const content = roadsContent([tileRoads(records), ...around]);
      const last = keeps ? await cache.get(`${prefix}${node}`) as RoadEntry | undefined : undefined;
      entry = last && last.content === content ? { sig, mesh: last.mesh, content } : { sig, mesh: bakeTileRoads(records, around, ground), content };
      if (keeps) await cache.put(`${prefix}${node}`, entry);
    }
    return { kind: 'far', node, sig, payload: job.want ? entry.mesh : null };
  }
  if (!keeps) return { kind: 'farNoCache', node, sig };
  if (!entry) {
    const children = job.children ?? [];
    // MIXING: a quarter no tile is made under yet is the plan's (baked here once per world and kept); the others' bakes are read.
    const planned = async (key: string): Promise<RoadEntry | undefined> => {
      const known = await kept(planKey(key), PLAN_SIG);
      if (known || !job.plan) return known;
      const at = farNode(key);
      const made: RoadEntry = { sig: PLAN_SIG, mesh: bakePlanRoads(job.plan, at.k, at.i, at.j, ground) };
      await cache.put(`${prefix}${planKey(key)}`, made);
      return made;
    };
    const got = await Promise.all(children.map((c) => (!c ? Promise.resolve(null) : c.sig === PLAN_SIG ? planned(c.key) : kept(c.key, c.sig))));
    const missing: string[] = [];
    children.forEach((c, n) => { if (c && !got[n]) missing.push(c.key); });
    if (missing.length) return { kind: 'farChildren', node, sig, missing };
    const side = TILE * 2 ** k;
    entry = { sig, mesh: mergeRoads(got.map((e) => e?.mesh ?? null), (i + 0.5) * side, (j + 0.5) * side, farLevelError(k)) };
    await cache.put(`${prefix}${node}`, entry);
  }
  return { kind: 'far', node, sig, payload: job.want ? entry.mesh : null };
}
