import { Box3, BufferAttribute, BufferGeometry, FrontSide, Group, type Material, Mesh, MeshStandardMaterial, Sphere, Vector3 } from 'three';
import type { Building } from '@world/buildings/types';
import { gatesOf } from '@world/parkingLayout';
import { canQueueJobs, jobWorkers, submitJob, type JobTicket } from '../jobs/jobPool';
import { forgetOtherDerived } from './derivedCache';
import { pullTowardEye } from './depthConvention';
import { type FarRoadJob, type FarRoadMesh, type FarRoadReply, derivedRoadCache, farLevelError, runFarRoadJob, tileRoads } from './farRoadTiles';
import { type FarKind, type FarLanded, type FarNearLanded, FarTree, type FarTreeJob, type FarTreeRun } from './farTree';
import { nodeSide } from './buildings/farTiles';
import { cellPriority, EDIT_TIER, FAR_TIER, TIER_SPAN } from './buildings/cellPool';
import { FAR_ERROR } from './buildings/massCells';
import { geometryCost } from './gpuLedger';
import { gpuOnly } from './mesh/gpuOnly';
import { readsRoadSection } from './mesh/roadEdges';
import { finish } from './mesh/surfaceMesh';
import { type NearRoadMesh, type NearTileRoads, type NearVariant, nearRoadsDigest } from './nearRoadTiles';
import { emptyRecords } from './buildings/farGrid';
import type { TileRecords } from '@world/doc';
import { COARSE_ERROR } from './mesh/roadLodPure';
import type { PassLook } from './roadSurfacePass';
import type { TileSource } from './roadTileShape';
import { PAINT_COLOURS } from './paintQuads';
import type { SharedGroundData } from './sharedGround';

/** What a node of the roads' tree carries: a far level's mesh, or a tile's near level (`nearRoadTiles.ts`). */
export type RoadPayload = FarRoadMesh | NearRoadMesh;

/** THE ROADS OF THE TILES NOT IN THE PAGE'S DOCUMENT (CLAUDE.md "Streaming world"): baked per tile in workers from the tile store (`farRoadTiles.ts`), chosen as a quadtree (`farTree.ts`), drawn with one material */

declare const __FAR_ROADS_HASH__: string | undefined;
/** The fingerprint of the code the far roads are baked by (`cook-plugin.ts`): bakes are kept under it; none (tests): nothing kept. */
const FAR_HASH = typeof __FAR_ROADS_HASH__ !== 'undefined' && __FAR_ROADS_HASH__ ? __FAR_ROADS_HASH__ : null;
const FAR_PREFIX = FAR_HASH ? `farRoads:${FAR_HASH}:` : null;

/** The linear colour of an sRGB byte colour, in the vertex shader (IEC 61966-2-1). */
const LINEAR_GLSL = /* glsl */ `
vec3 farLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}`;

/** THE ONE MATERIAL OF THE FAR ROADS: lit as the near streets (rough, no metal), the colours their vertices', the vertices compact (`FarRoadMesh`) */
function createFarRoadMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.55, side: FrontSide });
  material.name = 'far-roads';
  // Over the land they lie on, whichever way the depth runs (`depthConvention.ts`).
  pullTowardEye(material, 1, 2);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 farXZ;\nattribute float farHeight;\n${LINEAR_GLSL}`)
      // The plan is scaled by the mesh (x and z by 1/q, `farRoadMesh`): the normal is given in the world's axes and taken back into the mesh's here.
      .replace('#include <beginnormal_vertex>', 'float farScale = length(modelMatrix[0].xyz);\nvec3 objectNormal = vec3(normal.x * farScale, normal.y, normal.z * farScale);')
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(farXZ.x, farHeight, -farXZ.y);')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = farLinear(vColor.rgb);');
  };
  material.customProgramCacheKey = () => 'far-roads';
  return material;
}

/** A far road mesh's geometry: plan int16 (`farXZ`), height float, normal and colour bytes; no `position` (what reads one, a pass with its own material, draws nothing of it). */
function farGeometry(data: Pick<FarRoadMesh, 'xz' | 'height' | 'normal' | 'color' | 'index'>): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('farXZ', new BufferAttribute(data.xz, 2));
  g.setAttribute('farHeight', new BufferAttribute(data.height, 1));
  g.setAttribute('normal', new BufferAttribute(data.normal, 4, true));
  g.setAttribute('color', new BufferAttribute(data.color, 4, true));
  g.setIndex(new BufferAttribute(data.index, 1));
  return g;
}

/** A node's mesh: placed at its origin, its plan scaled by 1/q; its bounds set by hand (three would read them off `position`). */
function farRoadMesh(data: FarRoadMesh, material: MeshStandardMaterial): FarLanded {
  const g = farGeometry(data);
  const [x0, y0, x1, y1, h0, h1] = data.bounds as unknown as [number, number, number, number, number, number];
  const q = data.q;
  // In the mesh's own axes (plan times q, height as is).
  g.boundingBox = new Box3(new Vector3((x0 - data.ox) * q, h0, -(y1 - data.oy) * q), new Vector3((x1 - data.ox) * q, h1, -(y0 - data.oy) * q));
  // DO NOT take the sphere's radius in the mesh's axes: three scales it by the largest scale of the mesh (1 while q >= 1), so it is given in metres over that.
  const radius = Math.hypot(x1 - x0, y1 - y0, h1 - h0) / 2;
  g.boundingSphere = new Sphere(new Vector3(((x0 + x1) / 2 - data.ox) * q, (h0 + h1) / 2, -((y0 + y1) / 2 - data.oy) * q), radius / Math.max(1, 1 / q));
  const mesh = new Mesh(g, material);
  mesh.name = 'roads-far';
  mesh.position.set(data.ox, 0, -data.oy);
  mesh.scale.set(1 / q, 1, 1 / q);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  // Flat on the ground: it casts nothing, it takes the buildings' shadows as the near streets do.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  gpuOnly(mesh, () => ({}));
  return { mesh, x0, y0, x1, y1, top: h1, error: data.error };
}

/** What the roads' near level reads of the page (`renderer.ts`): the roads' look and paint as the region draws them, each surface's material, the ground's flag. */
export interface NearRoadKit {
  look(): PassLook;
  markingStyle(): string;
  naturalIsGround(): boolean;
  /** Whether the ground the roads are baked on is known yet (the buildings put on it once): no near level is asked before. */
  ready?(): boolean;
  /** A surface's material, shadow and order (`roadSurfaces.ts` surfaceLook). */
  dress(source: TileSource, raised: boolean): { readonly material: Material; readonly castShadow?: boolean; readonly renderOrder?: number };
  /** Whether the coarse levels go first in the queue (the town behind the curtain, `CellPool.coarseFirst`): a near level is a cell's detail, put back with them. */
  coarseFirst?(): boolean;
}

/** A tile the page holds, as a near bake reads it: its roads, and its buildings' gates (worked out here where the records have none: the page's own, a tile written before they were kept); null, one the worker reads from the store. */
const nearRoadsOf = (records: NonNullable<FarTreeJob['records']> | null): NearTileRoads | null => (records ? {
  ...tileRoads(records), gates: records.gates ?? gatesOf(records.buildings as readonly Building[]),
} : null);

/** A tree's job as the far roads' job: the tile the page read (the desktop's store) cut to its roads (`tileRoads`), its buildings never posted; the store's map kept for the worker to read the tile itself; a near level's with the page's look of the roads and the ground (`kit`). */
export function farRoadJob(tree: FarTreeJob, kit?: NearRoadKit | null, ground: SharedGroundData | null = null): FarRoadJob {
  const { records, near, aroundRecords, ...job } = tree;
  if (near) {
    if (!kit) throw new Error('a near level asked of roads with no near kit');
    return {
      ...job,
      near: {
        look: kit.look(), markingStyle: kit.markingStyle(), ground, naturalIsGround: kit.naturalIsGround(), tiles: near.tiles,
        bake: near.bake, variant: near.variant as NearVariant, shown: near.shown,
        ...(near.records ? { records: near.records.map(nearRoadsOf) } : {}),
      },
    };
  }
  return { ...job, ...(records ? { records: tileRoads(records) } : {}), ...(aroundRecords ? { aroundRecords: aroundRecords.map(tileRoads) } : {}) };
}

/** A far roads job's place in the queue (lower first): a far level in the far levels' band; a near level of a tile the page holds edited before anything (`cellPool.ts` EDIT_TIER): it draws what the player just did. */
export function farRoadPriority(tree: FarTreeJob, kit: NearRoadKit | null): number {
  if (!tree.near) return FAR_TIER * TIER_SPAN;
  if (tree.near.edited) return EDIT_TIER * TIER_SPAN;
  // DO NOT put a near level behind every building's cell, facade and mass of the queue, at any distance (NEAR_TIER): the street under the eye stood in its far level for seconds behind the district's cells (`conferencia` 09-street, 2026-10-17; found by the near-tiles session). It is asked as a cell's detail is, where its error spans the pixels allowed (`FarTree.wantsNear`): in the cells' band, nearest the eye first (the queue adds the distance), put back with them behind the curtain.
  return cellPriority('cell', 0, false, kit?.coarseFirst?.() ?? false);
}

/** A near level asked of the queue and not yet taken by a worker: asked again in its band when the curtain lifts (`FarRoadsRunner.reband`). */
interface WaitingNear {
  readonly tree: FarTreeJob;
  readonly done: (reply: FarRoadReply) => void;
  priority: number;
  sent: boolean;
  ticket: JobTicket | null;
}

/** The far roads' jobs, and what puts their waiting near levels back in their band. */
interface FarRoadsRunner {
  readonly run: FarTreeRun<RoadPayload>;
  /** The town shown or hidden (`kit.coarseFirst`): the near levels no worker took are asked again in the band it gives them now. */
  reband(): void;
}

/** DO NOT bake on the page: the far jobs go to the job system's queue (`farRoads` service), the page only when no worker can run (tests) */
export function farRoadsRunner(ground: () => SharedGroundData | null, kit: NearRoadKit | null): FarRoadsRunner {
  // DO NOT leave a near level asked behind the curtain in the detail's later band once the town shows: the queue ranks a job by the band it was asked in, and after a reload the street at the camera waited behind the whole re-bake (as the cells did, `CellPool.coarseFirst`, conferencia 97-98).
  const waiting = new Set<WaitingNear>();
  const submit = (asked: WaitingNear): void => {
    const { tree } = asked;
    const side = nodeSide(Math.max(0, tree.k));
    asked.sent = false;
    asked.ticket = submitJob({
      service: 'farRoads',
      key: `farRoads:${tree.node}`,
      priority: asked.priority,
      at: [(tree.i + 0.5) * side, (tree.j + 0.5) * side],
      write: () => { asked.sent = true; waiting.delete(asked); return { data: { ...farRoadJob(tree, kit, ground()), ground: ground() }, transfer: [] }; },
      done: (answer) => { waiting.delete(asked); asked.done(answer as FarRoadReply); },
      failed: (message) => { waiting.delete(asked); asked.done({ kind: 'farError', node: tree.node, sig: tree.sig, message }); },
    });
  };
  const run: FarTreeRun<RoadPayload> = (tree, done) => {
    if (!canQueueJobs()) {
      const job = farRoadJob(tree, kit, ground());
      let live = true;
      void runFarRoadJob({ ...job, ground: ground() }, derivedRoadCache).then(
        (reply) => { if (live) done(reply); },
        (error: unknown) => { if (live) done({ kind: 'farError', node: job.node, sig: job.sig, message: String(error) }); },
      );
      return () => { live = false; };
    }
    const asked: WaitingNear = { tree, done: (reply) => done(reply), priority: farRoadPriority(tree, kit), sent: false, ticket: null };
    if (tree.near) waiting.add(asked);
    submit(asked);
    return Object.assign(() => { waiting.delete(asked); asked.ticket?.cancel(); }, { started: () => asked.sent });
  };
  const reband = (): void => {
    for (const asked of waiting) {
      if (asked.sent || !asked.ticket?.pending) { waiting.delete(asked); continue; }
      const priority = farRoadPriority(asked.tree, kit);
      if (priority === asked.priority) continue;
      asked.ticket.cancel();
      asked.priority = priority;
      submit(asked);
    }
  };
  return { run, reband };
}

/** Each vertex's place in no road's section (`tileMesh.ts`: a surface without one). */
function noSection(vertices: number): Float32Array {
  const out = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) out[v * 3 + 1] = -1;
  return out;
}

/** One draw of a tile's near roads as the page draws it: its mesh, what it holds. */
interface DrawMesh {
  readonly mesh: Mesh;
  readonly bytes: number;
}

/** A draw as a mesh, with the material, shadow and order the region gives its surface (`kit.dress`), the attributes its material reads alone (`surfaceTiles.ts` readsOf), bounded by its box; its arrays let go once on the GPU. */
function drawMesh(s: NearRoadMesh['draws'][number], kit: NearRoadKit): DrawMesh {
  const look = kit.dress(s.source, s.raised);
  const a = s.arrays;
  const vertices = a.position.length / 3;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(a.position, 3));
  g.setAttribute('normal', new BufferAttribute(a.normal, 3));
  g.setAttribute('uv', new BufferAttribute(a.uv, 2));
  if (look.material.vertexColors) g.setAttribute('color', new BufferAttribute(a.color ?? new Float32Array(vertices * 3).fill(1), 3));
  if (readsRoadSection(look.material)) g.setAttribute('roadSection', new BufferAttribute(a.section ?? noSection(vertices), 3));
  g.setIndex(new BufferAttribute(a.index, 1));
  g.boundingBox = new Box3(new Vector3(a.box[0], a.box[1], a.box[2]), new Vector3(a.box[3], a.box[4], a.box[5]));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new Sphere());
  const mesh = finish(g, { name: s.name, material: look.material, castShadow: look.castShadow ?? false, receiveShadow: true });
  if (look.renderOrder !== undefined) mesh.renderOrder = look.renderOrder;
  // Made again from the store when a lost context asks (the tree's `refill`).
  gpuOnly(mesh, () => ({}));
  return { mesh, bytes: geometryCost(g).bytes };
}

/** A TILE'S NEAR ROADS AS THE PAGE DRAWS THEM, a mesh a draw: the draws an answer brings made here; the others (an answer built on the version drawn, `base`) the drawn one's, taken over at the swap (`adopt`), never made nor sent to the GPU again */
class NearRoadLanded implements FarNearLanded {
  readonly group = new Group();
  readonly meshes: Mesh[] = [];
  readonly bytes: number;
  readonly triangles: number;
  readonly top: number;
  readonly bake: string;
  readonly variant: string;
  /** Its draws: those it made, and those it keeps of the version drawn (theirs until `adopt`). */
  private readonly draws = new Map<string, DrawMesh>();
  private readonly mine = new Set<string>();

  constructor(data: NearRoadMesh, bake: string, kit: NearRoadKit, base: NearRoadLanded | null) {
    this.group.name = 'roads-near';
    this.group.matrixAutoUpdate = false;
    this.bake = bake;
    this.variant = data.variant;
    this.top = data.bounds[5]!;
    let bytes = 0;
    for (const draw of data.draws) {
      const made = drawMesh(draw, kit);
      this.draws.set(draw.key, made);
      this.mine.add(draw.key);
      this.group.add(made.mesh);
      this.meshes.push(made.mesh);
      bytes += made.bytes;
    }
    for (const key of data.keys) {
      if (this.draws.has(key)) continue;
      const kept = base?.draws.get(key);
      if (kept) { this.draws.set(key, kept); bytes += kept.bytes; }
    }
    this.bytes = bytes;
    this.triangles = data.triangles;
  }

  adopt(base: FarNearLanded): void {
    const from = base as NearRoadLanded;
    for (const [key, draw] of this.draws) {
      if (this.mine.has(key) || from.draws.get(key) !== draw) continue;
      from.mine.delete(key);
      this.mine.add(key);
      this.group.add(draw.mesh);
    }
  }

  dispose(): void {
    for (const key of this.mine) this.draws.get(key)!.mesh.geometry.dispose();
    this.mine.clear();
  }
}

/** Every surface a near level draws, for its programs' stand-ins: each band, each median part, each paint colour of the catalogue. */
const NEAR_SOURCES: readonly TileSource[] = [
  ...(['verge', 'footway', 'curbRamp', 'kerb', 'asphalt'] as const).map((band): TileSource => ({ kind: 'band', band })),
  ...(['kerb', 'planting', 'paved'] as const).map((part): TileSource => ({ kind: 'median', part })),
  ...PAINT_COLOURS.map((color): TileSource => ({ kind: 'paint', color })),
];

/** THE FAR ROADS: the tree of their levels, with the material its meshes share */
export class FarRoads extends FarTree<RoadPayload> {
  private readonly material: MeshStandardMaterial;
  private readonly standIn: Mesh;
  /** The queue's runner (none when the tests give their own). */
  private readonly queued: FarRoadsRunner | null;
  private coarseSeen: boolean | null = null;

  /** `ground`: the ground shared with the workers (null: flat at 0); `run`, `prefix`: where the jobs go and the bakes are kept (tests give their own); `near`: the page's look of the roads, for each tile's near level where the view wants its detail (none: the far levels alone). */
  constructor(ground: () => SharedGroundData | null, run?: FarTreeRun<RoadPayload>, prefix: string | null = FAR_PREFIX, near: NearRoadKit | null = null) {
    const material = createFarRoadMaterial();
    const kind: FarKind<RoadPayload> = {
      name: 'roads', land: (data) => farRoadMesh(data as FarRoadMesh, material), levelError: farLevelError,
      // Drawn from the plan where no tile is made yet, down to a tile (`farRoadTiles.ts` bakePlanRoads): the roads go on past the tiles made, as the buildings do.
      planFrom: 0,
      // A tile's far level is its near level's share of the ground (`farRoadTiles.ts` tileShare), read with the tiles round it.
      readsAround: true,
      // Where the buildings' cells come near (`massCells.ts` FAR_ERROR): the roads under them with their own detail.
      // Its simplified level near, its full detail where the simplification would show (`roadLodPure.ts` COARSE_ERROR); every tile drawn here, those of the page's document too: one way for the roads.
      ...(near ? {
        near: {
          error: FAR_ERROR, fineError: COARSE_ERROR, drawsLoaded: true,
          land: (data: RoadPayload, base: FarNearLanded | null) => new NearRoadLanded(data as NearRoadMesh, (data as NearRoadMesh).bake, near, base as NearRoadLanded | null),
          baseOf: (data: RoadPayload) => (data as NearRoadMesh).base,
          contentOf: (data: RoadPayload) => ({ bake: (data as NearRoadMesh).bake, variant: (data as NearRoadMesh).variant }),
          // The ground read as natural or built is in the bake (`contentSig`): in its version too, or a bake kept on the other one is taken as asked.
          version: () => `${near.markingStyle()}:${near.naturalIsGround() ? 1 : 0}`,
          ...(near.ready ? { ready: () => near.ready!() } : {}),
          pageCut: (records: TileRecords) => {
            const roads = nearRoadsOf(records)!;
            return { records: { ...emptyRecords(records.key, records.version), ...roads }, digest: nearRoadsDigest(roads) };
          },
        },
      } : {}),
    };
    const queued = run ? null : farRoadsRunner(ground, near);
    super(kind, run ?? queued!.run, prefix, canQueueJobs() ? jobWorkers() : 1);
    this.queued = queued;
    this.material = material;
    // The bakes of an older build of this code: let go.
    if (prefix !== null && prefix === FAR_PREFIX && FAR_HASH) forgetOtherDerived('farRoads', FAR_HASH);
    // Its program among the world's, compiled before the town is shown (`shaderCatalogue.ts` walks the scene, the hidden too): a stand-in never drawn.
    const standIn = new Group();
    standIn.name = 'roads-far-program';
    standIn.visible = false;
    const one = new Mesh(farGeometry({
      xz: new Int16Array(6), height: new Float32Array(3), normal: new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]),
      color: new Uint8Array(12).fill(255), index: new Uint16Array([0, 1, 2]),
    }), material);
    one.receiveShadow = true;
    one.frustumCulled = false;
    standIn.add(one);
    // DO NOT leave the near level's programs to their first draw: the region draws no road of the streamed world any more, so the opening's catalogue met none of them, and each was built in the frame a tile's near roads first came into view (the move's profile, 2026-10-17). One stand-in a look, raised and not (a raised surface casts: its depth program too).
    if (near) {
      const seen = new Set<string>();
      for (const raised of [false, true]) {
        for (const source of NEAR_SOURCES) {
          const look = near.dress(source, raised);
          const reads = readsRoadSection(look.material);
          const key = `${look.material.uuid}|${look.castShadow ?? false}|${reads}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
          g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
          g.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
          if (look.material.vertexColors) g.setAttribute('color', new BufferAttribute(new Float32Array(9).fill(1), 3));
          if (reads) g.setAttribute('roadSection', new BufferAttribute(noSection(3), 3));
          g.setIndex([0, 1, 2]);
          const mesh = new Mesh(g, look.material);
          mesh.name = 'roads-near-program';
          mesh.castShadow = look.castShadow ?? false;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          standIn.add(mesh);
          this.nearStandIns.push(mesh);
        }
      }
    }
    this.group.add(standIn);
    this.standIn = one;
  }

  /** The near level's program stand-ins (`constructor`). */
  private readonly nearStandIns: Mesh[] = [];

  /** The town behind its curtain or shown (`kit.coarseFirst`, set each frame as the buildings' `hidden`): on a change, the near levels waiting are asked again in their band now. */
  coarseFirst(on: boolean): void {
    if (on === this.coarseSeen) return;
    const first = this.coarseSeen === null;
    this.coarseSeen = on;
    if (!first) this.queued?.reband();
  }

  override dispose(): void {
    super.dispose();
    this.standIn.geometry.dispose();
    for (const mesh of this.nearStandIns) mesh.geometry.dispose();
    this.material.dispose();
  }
}
