import type { Frustum, Mesh, Object3D } from 'three';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import type { TileRecords } from '@world/doc';

/** WHAT THE FAR TREE (`farTree.ts`) IS TOLD AND ANSWERS: the tile store it reads, its jobs and their answers, what a kind of far thing gives it to draw, and its nodes */

/** Where the far levels read the tile store (the coordinator wires it) */
export interface FarTileSource {
  /** A tile as the page's document files it (`editor/tileStore.ts` `preparedRecords`: its buildings migrated, each a row of its tile's shared table); null when the store has none. */
  records(key: number): Promise<TileRecords | null>;
  /** The world's generator options: its fingerprint keys the bakes (one world's never read for another's); null: no such world. */
  readonly plan: WholeMapOptions | null;
  /** The store's map when the workers can read it themselves (`core/storedTiles.ts`, the browser's IndexedDB): a tile's records then never cross the page. */
  readonly workersRead?: string;
  /** The page's edit of a tile the store does not hold yet (`worldStreamer.ts` pageEdit: a serial; 0 when the store holds the tile as the page has it), and the tile as the page holds it: what a near level reads of a tile edited (`FarKind.near`), drawn from the edit on, not from the write seconds later. */
  pageEdit?(key: number): number;
  /** A serial that moves whenever any tile's `pageEdit` may have (`worldStreamer.ts` pageEdits): the choice keyed by it, not by every leaf's. */
  pageEdits?(): number;
  pageRecords?(key: number): TileRecords | null;
}

/** What the coordinator tells the buildings' far levels (`BuildingLayer.far`). */
export interface FarTiles {
  /** The store to read (and the world's plan) and which tiles the page's document holds now (the streamer's region): those are drawn by the cells, never here. */
  setSource(source: FarTileSource | null, isLoaded: (tileKey: number) => boolean): void;
  /** A tile written by the store at a version (made, changed), or gone (null): it and its ancestors baked again when wanted, nothing else. */
  stored(tileKey: number, version: number | null): void;
  /** A tile loaded into the page's document or unloaded from it: `isLoaded` read again for it. */
  loadedChanged(tileKey: number): void;
  /** The frame's error scale for the next `choose` (`buildings/frameBudget.ts`), as the cells' (`massCells.ts` `setErrorScale`). */
  setErrorScale(scale: number): void;
  /** The key prefix its bakes are kept under for the world set (`setSource`): what a tile's maker keeps its level 0 under (`cityTile.worker.ts`); null when nothing is kept. */
  readonly bakePrefix: string | null;
}

/** A job of the tree: a node at the version of the tiles under it, from the cache, its tile's records (level 0) or its children's bakes (above). */
export interface FarTreeJob {
  readonly node: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  readonly sig: string;
  /** Its mesh wanted back (to be drawn), or only baked and kept (for a parent). */
  readonly want: boolean;
  /** The cache's prefix; null: nothing kept, the levels past the tiles not made. */
  readonly prefix: string | null;
  /** Its quarters, null where no tile is stored under one. */
  readonly children?: readonly ({ readonly key: string; readonly sig: string } | null)[];
  /** The tile the page read (no worker reads the store): DO NOT post it whole, each kind's runner posts what its bake reads of it (the buildings' rows in their shared tables, `buildings/farLevels.ts` `farJobOf`; the roads alone, `farRoads.ts` `farRoadJob`). */
  readonly records?: TileRecords;
  /** The store's map the worker reads the tile from itself (`core/storedTiles.ts`), when it can (`FarTileSource.workersRead`): DO NOT drop it on the way to the worker. */
  readonly store?: string;
  /** The world's generator options, for a kind that bakes from the plan where no tile is made yet (`PLAN_SIG`). */
  readonly plan?: WholeMapOptions;
  /** Level 0 of a kind that reads its neighbours (`FarKind.readsAround`): the tiles round it stored, each at its version. */
  readonly around?: readonly { readonly key: number; readonly version: number }[];
  /** The page's records of `around` (no worker reads the store), in that order: DO NOT post them whole, as `records`. */
  readonly aroundRecords?: readonly TileRecords[];
  /** A tile's near level (`FarKind.near`): the tiles it reads, each at its version (the tile first, then its neighbours stored), the version of what it reads (`bake`), the level wanted and the version of it drawn now (`shown`: only what changed since comes back); the page's records of the tiles it holds edited (or of all, where no worker reads the store), in that order, null for one read from the store. */
  readonly near?: {
    readonly tiles: readonly { readonly key: number; readonly version: number }[];
    readonly bake: string;
    readonly variant: string;
    readonly shown: string | null;
    readonly records?: readonly (TileRecords | null)[];
    /** The tile itself held edited by the page: what the player just did, baked before anything (`cellPool.ts` EDIT_TIER). */
    readonly edited?: boolean;
  };
}

/** A job's answer, as `buildings/farTiles.ts` `FarReply`, its mesh's data a `payload`. */
export type FarTreeReply<P> =
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly payload: P | null }
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farChildren'; readonly node: string; readonly sig: string; readonly missing: readonly string[] }
  | { readonly kind: 'farNoCache'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** Runs a job and answers once; gives back its cancel (an answer cancelled is never given). */
export type FarTreeRun<P> = (job: FarTreeJob, done: (reply: FarTreeReply<P>) => void) => FarCancel;

/** A job's cancel; `started`, where the runner knows it: whether a worker took the job (its work under way, lost if cancelled). */
export type FarCancel = (() => void) & { readonly started?: () => boolean };

/** A node's mesh made of its data: the mesh, its plan box and highest point (what the eye measures), what it leaves out, m. */
export interface FarLanded {
  readonly mesh: Mesh;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly top: number;
  readonly error: number;
}

/** What a kind of far thing tells the tree: its meshes, and what each level may leave out before its mesh comes. */
export interface FarKind<P> {
  /** Its name in warnings. */
  readonly name: string;
  land(payload: P): FarLanded;
  levelError(k: number): number;
  /** The least pixels a level's error may span before it gives way to its quarters (none: the near levels' own, `massCells.ts` `measureSeen`): what a level draws never smaller on the screen than this asks. */
  levelPixels?(k: number): number;
  /** The finest level its worker bakes from the world's plan where no tile is made yet (`PLAN_SIG`); the levels under it only from tiles. None: nothing drawn where no tile is. */
  readonly planFrom?: number;
  /** A level under the tiles (the roads' near level, `nearRoadTiles.ts`); none: a tile is the finest the tree draws (the buildings', whose cells draw the near). */
  readonly near?: FarNear<P>;
  /** Whether a tile's own level reads the tiles round it (the roads, cut to the near level's share of the ground, `farRoadTiles.ts` tileShare): their versions are its version too. */
  readonly readsAround?: boolean;
}

/** A kind's level under its tiles, at two levels of its own: what a tile's own level leaves out that it draws (`error`, m: wanted where that spans the pixels allowed, as a cell comes near, `massCells.ts`), what its simplified level leaves out (`fineError`: its full detail wanted where that spans them), and its meshes. */
export interface FarNear<P> {
  readonly error: number;
  readonly fineError: number;
  /** A level's meshes from a job's answer; `base`, the one drawn now at that level, whose blocks the answer leaves out it keeps (`FarNearLanded.adopt`). */
  land(payload: P, base: FarNearLanded | null): FarNearLanded;
  /** Whether an answer builds on a version drawn (its blocks changed since alone): that version, else null. */
  baseOf(payload: P): string | null;
  /** What an answer is of: the content it was baked from and its level (a landed level's `bake` and `variant`); none: every answer is new. */
  contentOf?(payload: P): { readonly bake: string; readonly variant: string };
  /** What else it is baked from that the page may change (the roads' paint style): in its version. */
  version?(): string;
  /** Whether what it is baked from is known yet (the ground the buildings stand on): none asked before, as none is asked with the upload queue full. */
  ready?(): boolean;
  /** A tile the page holds edited, cut to what the near level reads, and the digest of that: the version an edited tile is asked at, so an edit of what it does not read (a building grown, a tree) asks nothing. */
  pageCut?(records: TileRecords): { readonly records: TileRecords; readonly digest: string };
  /** Whether it draws the tiles the page's document holds too (the roads: one way for every tile; the buildings' cells draw theirs). */
  readonly drawsLoaded?: boolean;
}

/** A tile's near level made of its data: what is drawn, the meshes made for it (sent to the GPU before it is drawn), what it holds, its highest point, the version of what it read and its level. */
export interface FarNearLanded {
  readonly group: Object3D;
  readonly meshes: readonly Mesh[];
  readonly bytes: number;
  readonly triangles: number;
  readonly top: number;
  readonly bake: string;
  readonly variant: string;
  /** At the swap: takes from the one drawn before the blocks it kept, which then lets go only the rest. */
  adopt(base: FarNearLanded): void;
  dispose(): void;
}

/** A node of the quadtree: a tile (level 0) or 2^k tiles a side; where the store has tiles, and where the plan is drawn. */
export interface FarNode {
  readonly key: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  readonly parent: FarNode | null;
  /** Its quarters (level 1 and up), by `di + 2 dj`; null where no tile is (and no plan node was made). */
  readonly children: (FarNode | null)[];
  /** Its box in the plan (grown to its mesh's) and its highest point. */
  x0: number; y0: number; x1: number; y1: number; top: number;
  /** Tiles stored under it (none: the plan's alone), and how many of them the page's document holds. */
  tiles: number;
  loaded: number;
  /** A tile's version, and whether the document holds it. */
  version: number;
  inDoc: boolean;
  /** The version of the tiles under it (null: one changed, worked out again when read, `sigOf`). */
  sig: string | null;
  /** The version a worker baked and kept it at. */
  baked: string | null;
  /** The version its mesh is of (null: nothing known to draw); a landed node with no mesh has nothing to draw. */
  landed: string | null;
  mesh: Mesh | null;
  error: number;
  asked: string | null;
  askedWant: boolean;
  cancel: (() => void) | null;
  /** Waiting for its children's bakes at this version: which, and whether its mesh is wanted then. */
  blocked: string | null;
  waitingFor: Set<string> | null;
  blockedWant: boolean;
  /** The version a worker failed to bake: not asked again. */
  failed: string | null;
  queued: boolean;
  /** A tile's near level (`FarKind.near`): drawn, and on its way to the GPU; the version of the tiles it reads it is of, asked, failed. */
  near: FarNearLanded | null;
  nearComing: FarNearLanded | null;
  nearLanded: string | null;
  nearAsked: string | null;
  nearCancel: FarCancel | null;
  /** The version the level on its way to the GPU stands for now: a newer answer of the same content moves it here, never the upload (`landNear`). */
  nearComingSig: string | null;
  nearFailed: string | null;
}

/** The eye the nodes were last chosen for (map x/y, height; a metre's pixels at a metre, or the orthographic view's; how far the view reaches, Infinity in perspective). */
export interface Eye { x: number; y: number; z: number; pxAtMetre: number; orthoPx: number | null; reach: number }

/** Whether two frusta (or none) are the same: every plane's normal and constant. */
export function sameView(a: Frustum | null, b: Frustum | null): boolean {
  if (a === null || b === null) return a === b;
  for (let i = 0; i < 6; i++) {
    const p = a.planes[i]!, q = b.planes[i]!;
    if (p.constant !== q.constant || !p.normal.equals(q.normal)) return false;
  }
  return true;
}
