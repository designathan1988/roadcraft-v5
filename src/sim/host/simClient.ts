import type { RoadDoc, Restoration, RecordPart, ValuePart } from '@world/doc';
import { type DocChangeKind, type JournalReader, TILE_LOADED } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import type { NetworkBake } from '@world/networkBuild';
import type { LotPlan } from '@world/lots';
import { OWNER, tileOfRecord } from '@world/tiles';
import type { BuildingId } from '@world/buildings/types';
import { buildingChangesOf, trafficMapOf } from '../agents/trafficBuildings';
import { ARCHETYPES, archetypeById, type Archetype } from '../vehicles/archetypes';
import type { KerbStop } from '../vehicles/kerbStops';
import type { PedView, PersonAgeClass } from '../people/view';
import type { VehicleFrames } from '../pose';
import type { SignalState } from '../signals/query';
import type { JunctionAnswer, TrafficCount } from './simAnswers';
import type { Casualty } from '../people/casualties';
import type { TileEvent } from '../meso/meso';
import { type FleetCell, FleetGrid, type GroundBox } from './fleetGrid';
import {
  C, H, P, PARKED_STRIDE, PED_STRIDE, PK, V, VEHICLE_STRIDE, headBase, makeSharedFrames, pedBase, vehicleBase,
  type FromSim, type ParkedChanges, type SignalLayout, type SimAct, type SimAsk, type SimControls, type SimStats, type ToSim, type TrainState, type Wound,
} from './protocol';

/** THE PAGE'S SIDE OF THE SIMULATION'S WORKER (`simHost.ts`): the map's changes sent, the frame read, the panels' questions asked */

/** A vehicle as the page draws it: its numbers of the last tick and what it carries (`VehicleRich`). */
export interface VehicleView {
  readonly id: number;
  archetype: Archetype;
  color: string;
  doors: readonly number[];
  kerbStop: KerbStop | null;
  people: readonly number[];
  peopleAge: readonly (PersonAgeClass | undefined)[];
  seats: number;
  slain: boolean;
  age: number;
  v: number;
  readonly prev: { v: number };
  /** Off the road: its pose a tick ago and now, and the lot it stands on; null on a lane. */
  free: { px: number; py: number; pangle: number; x: number; y: number; angle: number; lot: number | null } | null;
  readonly frames: VehicleFrames;
  /** The road its lane belongs to (undefined on a junction's connector), and the road it came from on one. */
  segment: SegmentId | undefined;
  inSegment: SegmentId | undefined;
  indicator: -1 | 0 | 1;
  curvature: number;
  odometer: number;
  /** The client's own: the tick it was last read in (`readTick`), those not read in a tick being gone. */
  tickRead: number;
}

/** A walker's view as the page makes it (`readTick`): the tick it was last read in, as a vehicle's. */
type PedRead = PedView & { tickRead: number };

/** A junction's signal heads and their lights as the worker last told them (`render/signals.ts`). */
export interface SignalFeed {
  /** The junctions whose heads moved since `serial` (null: every junction), and the serial now. */
  changesSince(serial: number): { readonly serial: number; readonly nodes: readonly NodeId[] | null };
  layout(node: NodeId): SignalLayout | undefined;
  /** A group's colour, and the junction's stage key (moves when any of its lights does). */
  state(node: NodeId, group: number): SignalState;
  stage(node: NodeId): string;
  nodes(): Iterable<NodeId>;
}

/** Wall seconds an answer is kept with nobody asking it again: the panels ask every 0.4 s (`main.ts` panelsDue), five rounds missed. */
const ANSWER_KEPT = 2;

/** A panel's question as a key: its kind and the one id it names (never its JSON). */
function askKey(ask: SimAsk): string {
  return `${ask.kind}:${ask.kind === 'segment' ? ask.id : ask.node}`;
}

/** The kinds of the diary the worker's copy of the map follows, and what each carries. */
const RECORD_KINDS: Readonly<Partial<Record<DocChangeKind, readonly RecordPart[]>>> = {
  roads: ['nodes', 'segments'], traffic: ['nodes', 'segments'], lots: ['lots'],
};
const VALUE_KINDS: Readonly<Partial<Record<DocChangeKind, ValuePart>>> = { transit: 'transit' };
/** DO NOT send a building's record (nor its wear): the worker is sent its traffic record (`agents/trafficBuildings.ts`). */
const FOLLOWED: readonly DocChangeKind[] = [...Object.keys(RECORD_KINDS), ...Object.keys(VALUE_KINDS), 'lotKeys', 'buildings'] as DocChangeKind[];

export class SimClient implements JournalReader {
  /** The kinds the worker's copy follows: the diary keeps them until this client has sent them (`changes.follow`). */
  readonly kinds = FOLLOWED;
  private worker: Worker | null = null;
  private readonly frames = makeSharedFrames();
  private readonly data = new Float64Array(this.frames.data);
  private readonly control = new Int32Array(this.frames.control);
  /** The diary read up to (what the worker's copy of the map stands at), in the document it is of. */
  private seen = -1;
  private seenDoc: RoadDoc | null = null;
  /** The lot keys the worker's copy holds, in its order (what was sent): DO NOT send the whole list when some go (a tile let go), only the stretches taken out and the keys put in. */
  private sentKeys: string[] = [];
  /** The lot store's `keysRewritten` when the keys were last sent: unchanged, only the keys added since go. */
  private lotKeysRewritten = -1;
  /** A frame asked of the worker and not answered: the next waits, its wall time added up meanwhile. */
  private inFlight = false;
  /** The worker's last failure (`failed`), null while none. */
  failure: string | null = null;
  private wallOwed = 0;
  /** The tile store told to the worker once it is up (`tiles`). */
  private tileStore: { readonly map: string; readonly reach: number; readonly port: MessagePort | null } | null = null;
  /** Whether the worker reads the streamed world's tiles itself (`tiles`): a tile's buildings are not worked out here when it comes in. */
  private workerReadsTiles = false;
  /** THE WORKER'S COPY HOLDS THE ACTIVE REGION ONLY (CLAUDE.md "Streaming world": micro in the active region, meso everywhere from the store's tables): `isActive`, the streamed world's active tiles (`worldStreamer.ts`); null, every tile of the document (a round city). */
  private isActive: ((key: number) => boolean) | null = null;
  /** The tiles whose records the worker's copy holds now, while `isActive` is set. */
  private readonly held = new Set<number>();
  private readonly pending = new Map<number, (value: unknown) => void>();
  private nextAsk = 1;
  /** The panels' last answers by question (`askKey`), each with the page's clock it was last asked at: dropped once nobody asks (`frame`). */
  private readonly answers = new Map<string, { value: unknown; asked: number }>();
  /** Wall seconds of the page's frames (`frame`), for the answers' age. */
  private askClock = 0;
  private sweptAt = 0;

  readonly vehicles = new Map<number, VehicleView>();
  /** The traffic and the cars parked in bays, whole; DO NOT walk them per frame or per query: ask by place (`vehiclesIn`). */
  readonly traffic: VehicleView[] = [];
  readonly parked: VehicleView[] = [];
  private readonly parkedById = new Map<number, VehicleView>();
  /** Each parked view's place in `parked` (taken out by swapping the last in, not by listing them all again). */
  private readonly parkedAt = new Map<VehicleView, number>();
  /** The traffic and the parked cars by 64 m cell, filed as the tick is decoded (`fleetGrid.ts`). */
  private readonly trafficGrid = new FleetGrid<VehicleView>();
  private readonly parkedGrid = new FleetGrid<VehicleView>();
  /** The longest step of the last tick (each axis): a pose drawn between the two ticks stands that far from the one filed at most. */
  private trafficSlack = 0;
  private parkedSlack = 0;
  /** The parked cars whose two poses differ (moved by the slot): settled on the next tick that tells no parked change, as before. */
  private readonly settling = new Set<VehicleView>();
  /** The traffic's speeds summed and how many stand (under 0.5), as the last tick's decode found them (the status, `main.ts`). */
  trafficSpeed = 0;
  trafficQueued = 0;
  readonly pedViews: PedView[] = [];
  /** Told each view let go, traffic or parked, as it goes (the casting forgets its people, `render/agents.ts`): DO NOT make the casting walk every vehicle it cast to find the gone ones. */
  onVehicleGone: ((view: VehicleView) => void) | null = null;
  /** Whether a view is one of the cars parked in their bays now. */
  isParked(view: VehicleView): boolean {
    return this.parkedById.get(view.id) === view;
  }

  /** The views that may be drawn in the box this frame, appended to `out` after clearing it: the traffic, then the parked cars (`which` keeps one of them). */
  vehiclesIn(box: Readonly<GroundBox>, out: VehicleView[], which: 'all' | 'traffic' | 'parked' = 'all'): VehicleView[] {
    out.length = 0;
    // Grown by the tick's longest step: the pose drawn lies between the two the frames hold (`framesPoseInto`).
    if (which !== 'parked') { const s = this.trafficSlack; this.trafficGrid.near(box.x0 - s, box.y0 - s, box.x1 + s, box.y1 + s, out); }
    if (which !== 'traffic') { const s = this.parkedSlack; this.parkedGrid.near(box.x0 - s, box.y0 - s, box.x1 + s, box.y1 + s, out); }
    return out;
  }

  /** The cells of the parked cars the box reaches (grown by the settling cars' step), appended to `out` after clearing it: each with its version, which moves when a parked car comes into it, goes or changes there (`FleetGrid`); DO NOT walk the parked cars of a cell whose version stands. */
  parkedCellsIn(box: Readonly<GroundBox>, out: FleetCell<VehicleView>[]): FleetCell<VehicleView>[] {
    out.length = 0;
    const s = this.parkedSlack;
    return this.parkedGrid.cellsNear(box.x0 - s, box.y0 - s, box.x1 + s, box.y1 + s, out);
  }

  private addParked(view: VehicleView): void {
    this.parkedById.set(view.id, view);
    this.parkedAt.set(view, this.parked.push(view) - 1);
  }

  private dropParked(view: VehicleView): void {
    this.parkedById.delete(view.id);
    const at = this.parkedAt.get(view);
    if (at !== undefined) {
      const last = this.parked.pop()!;
      if (at < this.parked.length) { this.parked[at] = last; this.parkedAt.set(last, at); }
      this.parkedAt.delete(view);
    }
    this.parkedGrid.remove(view);
    this.settling.delete(view);
    this.onVehicleGone?.(view);
  }

  /** Another map: every parked view let go at once. */
  private clearParked(): void {
    const gone = this.onVehicleGone;
    if (gone) for (const view of this.parked) gone(view);
    this.parked.length = 0;
    this.parkedById.clear();
    this.parkedAt.clear();
    this.parkedGrid.clear();
    this.settling.clear();
    this.parkedSlack = 0;
  }
  private readonly pedById = new Map<number, PedRead>();
  trains: readonly TrainState[] = [];
  /** The simulation's clock as last told: seconds, the city's minutes, the tick's share gone by (`alpha`). */
  time = 0;
  minutes = 0;
  alpha = 1;
  lastSteps = 0;
  lastStepMs = 0;
  stats: SimStats | null = null;
  /** The player's settings of the simulation, sent with every frame (`frame`). */
  readonly clock = { speed: 1, paused: false, client: this as SimClient, get time(): number { return this.client.time; } };
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  demandMultiplier = 1;
  /** The simulation stopped by the player, as the last frame sent it. */
  get paused(): boolean { return this.clock.paused; }
  /** The simulation's own checks told so far (`sim/invariants.ts`), oldest first. */
  readonly issues: SimStats['issues'][number][] = [];
  /** The topology the worker's simulation stands at (the network's `trafficRevision` it caught up to). */
  get topologyRevision(): number { return this.stats?.topologyRevision ?? -1; }
  /** What the simulation must show in full round the view (`render/renderer.ts` sets it each frame; sent with the next frame). */
  focus: SimControls['focus'] = null;
  /** Called with each frame read (a tick written), and once the worker stands. */
  onTick: (() => void) | null = null;
  private readonly layouts = new Map<NodeId, SignalLayout>();
  private readonly lights = new Map<NodeId, { stage: string; readonly states: Map<number, SignalState> }>();
  /** What the vehicles and the people carry as told this tick, by id (`readTick`): one map each, emptied and filled each tick. */
  private readonly vehicleRich = new Map<number, Extract<FromSim, { type: 'tick' }>['vehicles'][number][1]>();
  private readonly pedRich = new Map<number, Extract<FromSim, { type: 'tick' }>['peds'][number][1]>();
  private readonly signalLog: NodeId[] = [];
  private signalBase = 0;
  private signalAll = 0;

  /** The frames read so far (a tick of the worker each). */
  tick = 0;
  /** The wounds told since the effects last took them (`takeWounds`), and the casualties of blows, their clocks kept here. */
  private wounds: Wound[] = [];
  private casualtyList: Casualty[] = [];

  constructor(readonly doc: RoadDoc) {}

  /** The wounds told since the last call, taken (`render/playEffects.ts`). */
  takeWounds(): Wound[] {
    const out = this.wounds;
    this.wounds = [];
    return out;
  }

  /** The casualties of blows, their clocks advanced by `dt`, a minute's worth kept (`people/casualties.ts` impactCasualties). */
  casualties(dt = 0): readonly Casualty[] {
    for (const c of this.casualtyList) c.t += dt;
    if (this.casualtyList.length && this.casualtyList[0]!.t > 60) this.casualtyList = this.casualtyList.filter((c) => c.t <= 60);
    return this.casualtyList;
  }

  /** The worker made and given the map; resolved once it stands. */
  /** `lanes`: the page's job lanes for the worker's bays and conflict pairs (`main.ts`, `jobPool.ts` jobChannel), handed before `init`; none: it opens its own. */
  start(seed: number, zones: ReadonlyMap<string, Float64Array | null>, zonesPrefix: string | null, ambient: 'view' | 'edges',
    lanes: { readonly bays: readonly MessagePort[]; readonly conflicts: readonly MessagePort[] } | null = null): Promise<void> {
    const worker = new Worker(new URL('../sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    if (lanes) {
      const message: ToSim = { type: 'lanes', bays: lanes.bays, conflicts: lanes.conflicts };
      worker.postMessage(message, [...lanes.bays, ...lanes.conflicts]);
    }
    const ready = new Promise<void>((done) => {
      worker.onmessage = (event: MessageEvent<FromSim>) => {
        if (event.data.type === 'ready') { worker.onmessage = (e: MessageEvent<FromSim>) => this.receive(e.data); done(); return; }
        this.receive(event.data);
        // DO NOT wait for a ready that will never come: the game opens without its traffic, and says so.
        if (event.data.type === 'failed') done();
      };
      // A worker that cannot load or throws, or a message it cannot read: told as a failure, the opening let go (`main.ts` awaits it).
      const lost = (what: string): void => { this.receive({ type: 'failed', message: what }); done(); };
      worker.onerror = (event: ErrorEvent) => { event.preventDefault(); lost(`the worker stopped: ${event.message || 'it could not be loaded'}`); };
      worker.onmessageerror = () => lost('a message from the worker could not be read');
    });
    this.markSent();
    this.send({ type: 'init', frames: this.frames, map: trafficMapOf(this.doc), live: [...this.doc.loadedTiles], seed, zones, zonesPrefix, ambient });
    this.sendTiles();
    this.trimToActive();
    return ready;
  }

  /** The page's worker serving the worker's lanes of `service` failed: that pool falls back to working in the worker. */
  laneLost(service: 'bays' | 'conflicts'): void {
    this.send({ type: 'laneLost', service, why: `the job worker serving the ${service} lanes failed` });
  }

  /** Another map (opened, generated, new): the worker's copy made whole again (only what traffic reads), the simulation started over. */
  load(): void {
    this.markSent();
    this.send({ type: 'load', map: trafficMapOf(this.doc), live: [...this.doc.loadedTiles] });
    this.clearViews();
    this.trimToActive();
  }

  /** The streamed world's tile store the worker reads the meso's far tiles from itself (`meso/tileFeed.ts`): by its map's name in IndexedDB, or over `port` (the desktop's store); sent once the worker is up. */
  tiles(map: string, reach: number, port: MessagePort | null = null): void {
    this.tileStore = { map, reach, port };
    this.workerReadsTiles = true;
    this.sendTiles();
  }

  /** A tile of the page taken in, let go or written (`worldStreamer.ts` StreamerEvents): the meso hands its links between the lane graph and the tables. A tile taken in outside the active region is not the worker's (`setActive`). */
  tile(event: TileEvent, key: number, version = 0): void {
    if (this.isActive && event === 'loaded') { if (!this.isActive(key)) return; this.held.add(key); }
    if (this.isActive && event === 'letGo' && !this.held.delete(key)) return;
    if (event === 'loaded') { this.loaded(key, version); return; }
    this.send({ type: 'tile', event, key, version });
  }

  /** Whether the store is behind the page for a tile (`WorldStreamer.storeBehind`): a write of it not confirmed. */
  storeBehind: (key: number) => boolean = () => false;

  /** DO NOT let the worker read a tile from the store while the store is behind the page: it would take the buildings of before the edits. Its buildings sent from the page then. */
  private loaded(key: number, version: number): void {
    const fromPage = this.workerReadsTiles && this.storeBehind(key);
    if (fromPage) this.send({ type: 'delta', delta: { records: [], lists: [], values: [] }, buildings: buildingChangesOf(this.doc, this.doc.tileIds(key).buildings) });
    this.send({ type: 'tile', event: 'loaded', key, version, ...(fromPage ? { fromPage } : {}) });
  }

  /** The streamed world's active tiles: the worker's copy follows them alone (its records, the traffic's buildings, the meso's live tiles); null: every tile of the document. */
  setActive(isActive: ((key: number) => boolean) | null): void {
    this.isActive = isActive;
    if (!isActive) this.held.clear();
  }

  /** DO NOT let the worker solve again the junctions and ribbons the page has solved: a tile's bake from its worker (`editor/tileStore.ts`), sent as it is put in, for a tile the worker's copy holds. */
  offerBake(key: number, bake: NetworkBake): void {
    if (!this.worker || (this.isActive && !this.held.has(key))) return;
    // DO NOT post it where the worker reads the tile itself: it reads the tile's network from the store (`SimHost.tileBuildings`), unless the store is behind the page.
    if (this.workerReadsTiles && !this.storeBehind(key)) return;
    this.send({ type: 'bake', bake });
  }

  /** The loaded tiles that came into the active region or left it (`worldStreamer.ts` activeChanged): the worker's copy takes in their roads, lots and buildings, or lets them go to the meso's tables. */
  /** `bakeOf`: the page's junctions and ribbons of a tile coming in (`Network.exportBake`), sent before its records. */
  activeChanged(keys: readonly number[], bakeOf?: (nodes: readonly NodeId[], segments: readonly SegmentId[]) => NetworkBake): void {
    if (!this.isActive || !this.worker) return;
    // The diary up to now first: a tile's records go once, in order.
    this.sendChanges();
    for (const key of keys) {
      const active = this.isActive(key) && this.doc.hasTile(key);
      if (active === this.held.has(key)) continue;
      const t = this.doc.tileIds(key);
      const records: Restoration['records'][number][] = [];
      if (active) {
        this.held.add(key);
        // The page's own solved junctions only where the worker does not read the tile from the store (DO NOT export and post them for a tile it reads).
        if (bakeOf && !(this.workerReadsTiles && !this.storeBehind(key))) this.send({ type: 'bake', bake: bakeOf([...t.nodes, ...t.borrowedNodes], t.segments) });
        for (const id of [...t.nodes, ...t.borrowedNodes]) records.push({ part: 'nodes', id, value: this.nodeRecord(id) });
        for (const id of t.segments) records.push({ part: 'segments', id, value: recordOf(this.doc, 'segments', id) });
        for (const id of t.lots) records.push({ part: 'lots', id, value: recordOf(this.doc, 'lots', id) });
        // Its buildings: the worker reads the tile's traffic section from the store itself on 'loaded' (`SimHost.tileBuildings`); sent here only when it does not read tiles.
        const fromPage = this.workerReadsTiles && this.storeBehind(key);
        this.send({ type: 'delta', delta: { records, lists: [], values: [] }, buildings: this.workerReadsTiles && !fromPage ? [] : buildingChangesOf(this.doc, t.buildings) });
        this.send({ type: 'tile', event: 'loaded', key, version: 0, ...(fromPage ? { fromPage } : {}) });
      } else {
        this.held.delete(key);
        this.send({ type: 'tile', event: 'letGo', key, version: 0 });
        for (const id of t.segments) records.push({ part: 'segments', id, value: undefined });
        for (const id of t.lots) records.push({ part: 'lots', id, value: undefined });
        // A node stays while a road of a held tile ends on it (the page keeps a borrowed node the same way, `RoadDoc.unloadTile`), sent again without the roads let go.
        for (const id of [...t.nodes, ...t.borrowedNodes]) records.push({ part: 'nodes', id, value: this.usedByHeld(id) ? this.nodeRecord(id) : undefined });
        this.send({ type: 'delta', delta: { records, lists: [], values: [] }, buildings: t.buildings.map((id) => ({ id, ref: null })) });
      }
    }
  }

  /** A node's record for the worker's copy: among its roads, those of the tiles the worker holds alone (DO NOT send a leg of the kept ring: the worker's junction asks for a road it does not have). */
  private nodeRecord(id: NodeId): unknown {
    const node = this.doc.nodes.get(id);
    if (!node || !this.isActive) return node;
    const incident = node.incident.filter((sid) => { const t = this.tileOf('segments', sid, this.doc.segments.get(sid)); return t === null || this.held.has(t); });
    return incident.length === node.incident.length ? node : { ...node, incident };
  }

  /** Whether a road of a tile the worker holds ends on the node. */
  private usedByHeld(id: NodeId): boolean {
    const node = this.doc.nodes.get(id);
    if (!node) return false;
    for (const sid of node.incident) { const t = this.tileOf('segments', sid, this.doc.segments.get(sid)); if (t !== null && this.held.has(t)) return true; }
    return false;
  }

  /** The tile a record belongs to (`OWNER`): a road's by its ends as the page holds them; null when it cannot be said. */
  private tileOf(part: RecordPart, id: number, value: unknown): number | null {
    if (part === 'segments') {
      const s = value as { readonly a: NodeId; readonly b: NodeId } | undefined;
      const a = s && this.doc.nodes.get(s.a), b = s && this.doc.nodes.get(s.b);
      if (a && b) return OWNER.segment(a, b);
    }
    return tileOfRecord(part, id, value);
  }

  /** After the whole map was sent (`start`, `load`): the worker's copy holds every loaded tile; those outside the active region let go. */
  private trimToActive(): void {
    if (!this.isActive) return;
    this.held.clear();
    for (const key of this.doc.loadedTiles) this.held.add(key);
    this.activeChanged([...this.doc.loadedTiles]);
  }

  private sendTiles(): void {
    const t = this.tileStore;
    if (!t || !this.worker) return;
    this.tileStore = null;
    const message: ToSim = { type: 'tiles', map: t.map, reach: t.reach, port: t.port };
    this.worker.postMessage(message, t.port ? [t.port] : []);
  }

  /** The simulation started over on the same map. */
  reset(): void {
    this.send({ type: 'reset' });
  }

  /** The micro window round (x, y), and the buffer the worker writes the meso traffic into (`render/densityCars.ts`). */
  window(x: number, y: number, r: number, meso: SharedArrayBuffer): void {
    this.send({ type: 'window', x, y, r, meso });
  }

  /** A frame of the page: the map's changes since the last sent, then the wall time and the controls (one frame asked at a time). */
  frame(wall: number, hold: boolean, run: { readonly traffic: boolean; readonly pedestrians: boolean; readonly maxShare: number; readonly startShare?: number }): void {
    this.sendChanges();
    this.wallOwed += wall;
    this.askClock += wall;
    if (this.askClock - this.sweptAt >= ANSWER_KEPT) {
      // DO NOT keep every question ever asked: an answer no panel asked for over `ANSWER_KEPT` is let go.
      this.sweptAt = this.askClock;
      for (const [key, answer] of this.answers) if (this.askClock - answer.asked > ANSWER_KEPT) this.answers.delete(key);
    }
    if (this.inFlight || !this.worker) return;
    this.inFlight = true;
    const controls: SimControls = {
      speed: this.clock.speed, paused: this.clock.paused, traffic: run.traffic, pedestrians: run.pedestrians,
      trafficIntensity: this.trafficIntensity, pedestrianIntensity: this.pedestrianIntensity, demandMultiplier: this.demandMultiplier,
      maxShare: run.maxShare, ...(run.startShare !== undefined ? { startShare: run.startShare } : {}), focus: this.focus,
    };
    this.send({ type: 'frame', wall: this.wallOwed, hold, controls });
    this.wallOwed = 0;
  }

  /** The player's hand on the simulation, answered when the worker has done it. */
  act(act: SimAct): Promise<unknown> {
    const id = this.nextAsk++;
    return new Promise((done) => { this.pending.set(id, done); this.send({ type: 'act', id, act }); });
  }

  /** A panel's question: the last answer to it now (null before the first), a fresh one asked for the next refresh. */
  asked(ask: SimAsk): unknown {
    const key = askKey(ask);
    let answer = this.answers.get(key);
    if (!answer) this.answers.set(key, answer = { value: null, asked: this.askClock });
    answer.asked = this.askClock;
    const kept = answer;
    const id = this.nextAsk++;
    // An answer to a question let go meanwhile is not kept.
    this.pending.set(id, (value) => { if (this.answers.get(key) === kept) kept.value = value; });
    this.send({ type: 'ask', id, ask });
    return answer.value ?? null;
  }

  /** The zoning tool's proposed lots, planned in the worker on its copy of the region (`SimHost.lotPlan`): the diary sent first, so it plans the land as the page has it now; null when not now (no worker, a tile's network still read there). */
  lotPlan(): Promise<LotPlan | null> {
    if (!this.worker) return Promise.resolve(null);
    this.sendChanges();
    const id = this.nextAsk++;
    return new Promise((done) => { this.pending.set(id, (value) => done((value as LotPlan | null) ?? null)); this.send({ type: 'lotPlan', id }); });
  }

  /** A question answered when the worker has (the green wave). */
  ask(ask: SimAsk): Promise<unknown> {
    const id = this.nextAsk++;
    return new Promise((done) => { this.pending.set(id, done); this.send({ type: 'ask', id, ask }); });
  }

  segmentTraffic(id: SegmentId): TrafficCount | null {
    return this.asked({ kind: 'segment', id }) as TrafficCount | null;
  }

  junction(node: NodeId): JunctionAnswer | null {
    return this.asked({ kind: 'junction', node }) as JunctionAnswer | null;
  }

  /** The signalised junctions as the blows' posts read them (`world/signalPosts.ts`). */
  readonly signalJunctions = { junctions: new Map<NodeId, { readonly signalised: boolean; readonly groups: SignalLayout['groups'] }>() };

  readonly signals: SignalFeed = {
    changesSince: (serial) => {
      const now = this.signalBase + this.signalLog.length;
      if (serial < this.signalAll || serial < this.signalBase || serial > now) return { serial: now, nodes: null };
      return { serial: now, nodes: this.signalLog.slice(serial - this.signalBase) };
    },
    layout: (node) => this.layouts.get(node),
    state: (node, group) => this.lights.get(node)?.states.get(group) ?? 'red',
    stage: (node) => this.lights.get(node)?.stage ?? '',
    nodes: () => this.layouts.keys(),
  };

  private send(message: ToSim): void {
    this.worker?.postMessage(message);
  }

  /** What the worker's copy has been sent up to (`JournalReader`). */
  get seenSerial(): number {
    return this.seen;
  }

  private markSent(): void {
    this.seen = this.doc.changes.version;
    // DO NOT read the diary without following it: past 2 x KEPT entries of a kind it let them go, and the whole map was sent again each frame a city was laid out.
    if (this.seenDoc !== this.doc) this.doc.changes.follow(this);
    this.seenDoc = this.doc;
    this.sentKeys = this.doc.lotStore.keys.slice();
    this.lotKeysRewritten = this.doc.lotStore.keysRewritten;
  }

  /** The map's changes the worker's copy follows, since the last sent: by the records the diary names, or the whole map. */
  private sendChanges(): void {
    if (!this.worker) return;
    const changes = this.doc.changes;
    if (this.seenDoc !== this.doc) { this.load(); return; }
    if (changes.version === this.seen) return;
    const entries = changes.since(this.seen, FOLLOWED);
    if (entries === null) { this.load(); return; }
    this.seen = changes.version;
    if (!entries.length) return;
    const named = new Map<RecordPart, Set<number>>();
    const buildings = new Set<BuildingId>();
    const values = new Set<ValuePart>();
    let keys = false;
    for (const e of entries) {
      if (e.kind === 'buildings') {
        // A change of buildings that does not say which: the worker's copy made whole again.
        if (!e.ids) { this.load(); return; }
        // DO NOT work a tile's buildings out for the traffic here when it comes in: the worker reads the same tile from the store and does (`SimHost.tileBuildings`).
        if (e.cause === TILE_LOADED && this.workerReadsTiles) continue;
        for (const id of e.ids) buildings.add(id as BuildingId);
        continue;
      }
      const parts = RECORD_KINDS[e.kind as DocChangeKind];
      if (parts) {
        // A change of records that does not say which: the worker's copy made whole again.
        if (!e.ids) { this.load(); return; }
        for (const part of parts) {
          let set = named.get(part);
          if (!set) named.set(part, set = new Set());
          for (const id of e.ids) set.add(id);
        }
      }
      const value = VALUE_KINDS[e.kind as DocChangeKind];
      if (value) values.add(value);
      if (e.kind === 'lotKeys') keys = true;
    }
    const records: Restoration['records'][number][] = [];
    // The worker's copy holds the active tiles only: a record standing in another tile is not sent (one gone is: harmless); a road sent brings its ends, and a node a held road ends on stays.
    const keep = (part: RecordPart, id: number, value: unknown): boolean => {
      if (!this.isActive || value === undefined) return true;
      const tile = this.tileOf(part, id, value);
      return tile === null || this.held.has(tile);
    };
    const ends = new Set<number>();
    for (const part of ['segments', 'lots'] as const) {
      for (const id of named.get(part) ?? []) {
        const value = recordOf(this.doc, part, id);
        if (!keep(part, id, value)) continue;
        records.push({ part, id, value });
        if (part === 'segments' && value) { const s = value as { readonly a: NodeId; readonly b: NodeId }; ends.add(s.a); ends.add(s.b); }
      }
    }
    for (const id of named.get('nodes') ?? []) {
      const value = this.nodeRecord(id as NodeId);
      if (ends.has(id) || keep('nodes', id, value) || this.usedByHeld(id as NodeId)) records.push({ part: 'nodes', id, value });
    }
    const buildingList = [...buildings].filter((id) => { const b = this.doc.buildings.get(id); return !b || !this.isActive || this.held.has(OWNER.at(b)); });
    const lists: Restoration['lists'][number][] = [];
    if (keys) {
      const store = this.doc.lotStore, all = store.keys;
      // DO NOT send every key at each lot laid: the city's layout sent the whole list once per lot (O(lots²) copied).
      const sent = this.sentKeys;
      if (store.keysRewritten === this.lotKeysRewritten && all.length >= sent.length) {
        // Only added at the end since: the new tail.
        const items = all.slice(sent.length);
        lists.push({ part: 'lotKeys', start: sent.length, remove: 0, items });
        for (const key of items) sent.push(key);
      } else lists.push(...this.keyChanges());
      this.lotKeysRewritten = store.keysRewritten;
    }
    this.send({
      type: 'delta', delta: { records, lists, values: [...values].map((part) => ({ part, value: this.doc.valueOf(part) })) },
      buildings: buildingChangesOf(this.doc, buildingList),
    });
  }

  /** The worker's keys brought to the store's: each stretch no longer there taken out (from the end, so the places before it hold), then the keys it lacks put at its end. */
  private keyChanges(): Restoration['lists'][number][] {
    const store = this.doc.lotStore, sent = this.sentKeys;
    const out: Restoration['lists'][number][] = [];
    for (let n = sent.length - 1; n >= 0; n--) {
      if (store.hasKey(sent[n]!)) continue;
      let m = n;
      while (m > 0 && !store.hasKey(sent[m - 1]!)) m--;
      out.push({ part: 'lotKeys', start: m, remove: n - m + 1, items: [] });
      n = m;
    }
    const kept = sent.filter((key) => store.hasKey(key));
    const held = new Set(kept);
    const added = store.keys.filter((key) => !held.has(key));
    if (added.length) out.push({ part: 'lotKeys', start: kept.length, remove: 0, items: added });
    this.sentKeys = [...kept, ...added];
    return out;
  }

  private receive(message: FromSim): void {
    switch (message.type) {
      case 'tick': this.readTick(message); return;
      case 'acted': case 'answer': {
        const done = this.pending.get(message.id);
        this.pending.delete(message.id);
        done?.(message.type === 'acted' ? message.result : message.answer);
        return;
      }
      case 'ready': return;
      // DO NOT stay silent: the frame asked of it never comes, and the city would stand still with no word.
      case 'failed':
        // Told once (each frame after may fail the same way), the last kept for the probes.
        if (this.failure === null) console.error("[sim] the simulation's worker failed:", message.message);
        this.failure = message.message;
        this.inFlight = false;
        return;
    }
  }

  /** The frame the worker wrote: read from its slot (marked as being read), its rich parts from the message. */
  private readTick(message: Extract<FromSim, { type: 'tick' }>): void {
    this.inFlight = false;
    const slot = Atomics.load(this.control, C.latest);
    Atomics.store(this.control, C.reading, slot);
    const data = this.data, h = headBase(slot);
    this.time = data[h + H.time]!;
    this.minutes = data[h + H.minutes]!;
    this.alpha = data[h + H.alpha]!;
    this.lastSteps = data[h + H.steps]!;
    this.lastStepMs = data[h + H.stepMs]!;
    // What the vehicles carry, told for those whose changed: no map made a tick none did.
    // DO NOT make a map a tick: the tick's own, emptied and filled.
    const rich = message.vehicles.length ? fillMap(this.vehicleRich, message.vehicles) : null;
    // This tick's stamp (`tick` once read): a view not stamped by it was not in it (DO NOT gather the tick's ids in a set to find them).
    const stamp = this.tick + 1;
    // The cars parked in bays, as told: come, gone, or every one standing, each applied by its id (DO NOT clear them all and make every view again).
    if (message.parked) this.applyParked(message.parked, stamp);
    else {
      // The parked cars that moved last tick and not this one stand where they stopped: DO NOT walk every parked car for them.
      for (const view of this.settling) {
        const f = view.free;
        if (f && (f.px !== f.x || f.py !== f.y)) { f.px = f.x; f.py = f.y; f.pangle = f.angle; setFrames(view.frames, f.x, f.y, f.angle, f.x, f.y, f.angle); this.parkedGrid.touch(view); }
      }
      this.settling.clear();
    }
    const n = data[h + H.vehicles]!;
    const vb = vehicleBase(slot);
    this.traffic.length = 0;
    let read = 0;
    let speed = 0, queued = 0, slack = 0;
    for (let k = 0; k < n; k++) {
      const at = vb + k * VEHICLE_STRIDE;
      const id = data[at + V.id]!;
      const parked = data[at + V.free] === 2;
      let view = parked ? this.parkedById.get(id) : this.vehicles.get(id);
      if (!view) {
        view = newView(id);
        if (parked) this.addParked(view); else this.vehicles.set(id, view);
      }
      const r = rich?.get(id);
      if (r) {
        view.archetype = archetypeById(r.archetype);
        view.color = r.color;
        view.doors = r.doors;
        view.kerbStop = r.kerbStop;
        view.people = r.people;
        view.peopleAge = r.peopleAge;
      }
      const f = view.frames;
      setFrames(f, data[at + V.bx]!, data[at + V.by]!, data[at + V.bangle]!, data[at + V.x]!, data[at + V.y]!, data[at + V.angle]!);
      f.yawBefore = data[at + V.yawBefore]!; f.yawNow = data[at + V.yawNow]!; f.jump = data[at + V.jump] === 1;
      const lot = data[at + V.lot]!;
      if (data[at + V.free]! > 0) setFree(view, f.bx, f.by, f.bangle, f.x, f.y, f.angle, lot < 0 ? null : lot);
      else view.free = null;
      view.v = data[at + V.v]!; view.prev.v = data[at + V.prevV]!; view.age = data[at + V.age]!;
      const segment = data[at + V.segment]!, inSegment = data[at + V.inSegment]!;
      view.segment = segment < 0 ? undefined : segment as SegmentId;
      view.inSegment = inSegment < 0 ? undefined : inSegment as SegmentId;
      view.indicator = data[at + V.indicator]! as -1 | 0 | 1;
      view.curvature = data[at + V.curvature]!;
      view.odometer = data[at + V.odometer]!;
      view.seats = data[at + V.seats]!;
      view.slain = data[at + V.slain] === 1;
      if (parked) {
        this.parkedGrid.place(view);
        if (f.bx !== f.x || f.by !== f.y) this.settling.add(view);
        continue;
      }
      this.traffic.push(view);
      if (view.tickRead !== stamp) { view.tickRead = stamp; read++; }
      this.trafficGrid.place(view);
      const step = f.jump ? 0 : Math.max(Math.abs(f.x - f.bx), Math.abs(f.y - f.by));
      if (step > slack) slack = step;
      speed += view.v;
      if (view.v < 0.5) queued++;
    }
    // Every traffic view read this tick: none gone, and none walked to find out.
    if (read !== this.vehicles.size) {
      for (const [id, view] of this.vehicles) if (view.tickRead !== stamp) { this.vehicles.delete(id); this.trafficGrid.remove(view); this.onVehicleGone?.(view); }
    }
    this.trafficSpeed = speed;
    this.trafficQueued = queued;
    this.trafficSlack = slack;
    // The parked cars between two poses are the moved ones, still settling.
    let parkedSlack = 0;
    for (const view of this.settling) {
      const fr = view.frames;
      if (!fr.jump) parkedSlack = Math.max(parkedSlack, Math.abs(fr.x - fr.bx), Math.abs(fr.y - fr.by));
    }
    this.parkedSlack = parkedSlack;
    // The people: their numbers from the slot, what they carry from the message (kept from the last time it changed).
    const pedRich = message.peds.length ? fillMap(this.pedRich, message.peds) : null;
    const m = data[h + H.peds]!;
    const pb = pedBase(slot);
    this.pedViews.length = 0;
    let pedRead = 0;
    for (let k = 0; k < m; k++) {
      const at = pb + k * PED_STRIDE;
      const id = data[at + P.id]!;
      const r = pedRich?.get(id);
      let view = this.pedById.get(id);
      if (!view || r) {
        const base = r ?? view;
        if (!base) continue;
        const { id: _i, x: _x, y: _y, heading: _h, prev: _p, v: _v, turnV: _t, age: _a, segment: _s, walking: _w, kerbWait: _k, rank: _r, ...carried } = base as PedView;
        view = { ...carried, id, x: 0, y: 0, heading: 0, prev: { x: 0, y: 0, heading: 0 }, v: 0, turnV: 0, age: 0, segment: undefined, walking: false, kerbWait: 0, rank: 0, tickRead: -1 } as PedRead;
        this.pedById.set(id, view);
      }
      const w = view as { -readonly [K in keyof PedView]: PedView[K] };
      w.x = data[at + P.x]!; w.y = data[at + P.y]!; w.heading = data[at + P.heading]!;
      const prev = view.prev as { x: number; y: number; heading: number };
      prev.x = data[at + P.px]!; prev.y = data[at + P.py]!; prev.heading = data[at + P.pheading]!;
      w.v = data[at + P.v]!; w.turnV = data[at + P.turnV]!; w.age = data[at + P.age]!;
      const segment = data[at + P.segment]!;
      w.segment = segment < 0 ? undefined : segment as SegmentId;
      w.walking = data[at + P.walking] === 1; w.kerbWait = data[at + P.kerbWait]!; w.rank = data[at + P.rank]!;
      // A gesture is told once, when it starts: its clock (`t`) kept here from the age it started at (DO NOT have it told each tick for its clock).
      const gesture = view.gesture;
      if (gesture) {
        let from = GESTURE_FROM.get(gesture);
        if (from === undefined) GESTURE_FROM.set(gesture, from = w.age - gesture.t);
        gesture.t = w.age - from;
      }
      this.pedViews.push(view);
      if (view.tickRead !== stamp) { view.tickRead = stamp; pedRead++; }
    }
    if (pedRead !== this.pedById.size) for (const [id, view] of this.pedById) if (view.tickRead !== stamp) this.pedById.delete(id);
    Atomics.store(this.control, C.reading, -1);
    this.trains = message.trains;
    this.tick++;
    if (message.wounds.length) this.wounds.push(...message.wounds);
    if (message.casualties.length) this.casualtyList.push(...message.casualties);
    this.stats = message.stats;
    if (message.stats.issues.length) this.issues.push(...message.stats.issues);
    if (this.issues.length > 512) this.issues.splice(0, this.issues.length - 512);
    if (message.layout) {
      if (message.layout.all) { this.layouts.clear(); this.lights.clear(); this.signalJunctions.junctions.clear(); }
      for (const l of message.layout.junctions) {
        if (l.groups.length) { this.layouts.set(l.node, l); this.signalJunctions.junctions.set(l.node, { signalised: true, groups: l.groups }); }
        else { this.layouts.delete(l.node); this.lights.delete(l.node); this.signalJunctions.junctions.delete(l.node); }
        this.signalLog.push(l.node);
      }
      // Every junction told again: a reader of before places them all again (`changesSince` null).
      if (message.layout.all) this.signalAll = this.signalBase + this.signalLog.length;
      if (this.signalLog.length > 4096) { this.signalBase += this.signalLog.length; this.signalLog.length = 0; this.signalAll = this.signalBase; }
    }
    for (const s of message.signals) {
      // A junction's lights written into the map it has (DO NOT make one a junction a tick).
      const lit = this.lights.get(s.node);
      if (lit) { lit.stage = s.stage; fillMap(lit.states, s.states); } else this.lights.set(s.node, { stage: s.stage, states: new Map(s.states) });
    }
    this.onTick?.();
  }

  /** The parked cars' numbers (`PK`) applied by id: a known view written in place, a new one made, a gone one let go; with `whole`, those not named let go too. */
  private applyParked(told: ParkedChanges, stamp: number): void {
    const cars = told.cars;
    for (let at = 0; at < cars.length; at += PARKED_STRIDE) {
      const id = cars[at + PK.id]!;
      const known = this.parkedById.get(id);
      if (cars[at + PK.gone] === 1) { if (known) this.dropParked(known); continue; }
      const view = known ?? newView(id);
      view.archetype = ARCHETYPES[cars[at + PK.archetype]!] ?? archetypeById('');
      view.color = colourOf(cars[at + PK.color]!);
      const x = cars[at + PK.x]!, y = cars[at + PK.y]!, angle = cars[at + PK.angle]!, lot = cars[at + PK.lot]!;
      setFree(view, x, y, angle, x, y, angle, lot < 0 ? null : lot);
      view.v = 0; view.prev.v = 0; view.seats = 0;
      setFrames(view.frames, x, y, angle, x, y, angle);
      view.tickRead = stamp;
      if (!known) this.addParked(view);
      this.parkedGrid.place(view);
    }
    if (!told.whole) return;
    // Every car standing was named: those not stamped by this tick are gone (one pass over the list, only when the log was let go).
    for (let k = this.parked.length - 1; k >= 0; k--) {
      const view = this.parked[k]!;
      if (view.tickRead !== stamp) this.dropParked(view);
    }
  }

  private clearViews(): void {
    const gone = this.onVehicleGone;
    if (gone) for (const view of this.vehicles.values()) gone(view);
    this.vehicles.clear();
    this.traffic.length = 0;
    this.trafficGrid.clear();
    this.trafficSlack = 0;
    this.trafficSpeed = 0;
    this.trafficQueued = 0;
    this.clearParked();
    this.pedViews.length = 0;
    this.pedById.clear();
    this.layouts.clear();
    this.lights.clear();
    this.signalJunctions.junctions.clear();
    // Past every serial a reader of the map before holds (one more than the log's end): DO NOT let it read "nothing changed" (`changesSince` []) - the old map's heads stood on a new empty one; it places every junction again (null).
    this.signalBase += this.signalLog.length + 1;
    this.signalLog.length = 0;
    this.signalAll = this.signalBase;
  }
}

/** A map emptied and filled with the pairs. */
function fillMap<K, V>(map: Map<K, V>, pairs: readonly (readonly [K, V])[]): Map<K, V> {
  map.clear();
  for (const [k, v] of pairs) map.set(k, v);
  return map;
}

/** Each gesture told, by the age (`PedView.age`) its clock started at. */
const GESTURE_FROM = new WeakMap<object, number>();

/** A colour as the worker numbers it (0xrrggbb), as its palette writes it; the strings kept, one per colour. */
const COLOURS = new Map<number, string>();
function colourOf(n: number): string {
  let c = COLOURS.get(n);
  if (c === undefined) COLOURS.set(n, c = `#${n.toString(16).padStart(6, '0')}`);
  return c;
}

function newView(id: number): VehicleView {
  return {
    id, archetype: archetypeById('car'), color: '#888888', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0, prev: { v: 0 },
    free: null, frames: { bx: 0, by: 0, bangle: 0, x: 0, y: 0, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: -1,
  };
}

/** A view off the road: its two poses and its lot, into the pose it already has (DO NOT make one a vehicle a tick). */
function setFree(view: VehicleView, px: number, py: number, pangle: number, x: number, y: number, angle: number, lot: number | null): void {
  const free = view.free ?? (view.free = { px, py, pangle, x, y, angle, lot });
  free.px = px; free.py = py; free.pangle = pangle; free.x = x; free.y = y; free.angle = angle; free.lot = lot;
}

function setFrames(f: VehicleFrames, bx: number, by: number, bangle: number, x: number, y: number, angle: number): void {
  f.bx = bx; f.by = by; f.bangle = bangle; f.x = x; f.y = y; f.angle = angle; f.yawBefore = 0; f.yawNow = 0; f.jump = false;
}

/** A record of the map by its part, for the worker's copy (never a building's: `buildingChangesOf`). */
function recordOf(doc: RoadDoc, part: RecordPart, id: number): unknown {
  switch (part) {
    case 'nodes': return doc.nodes.get(id as NodeId);
    case 'segments': return doc.segments.get(id as SegmentId);
    case 'lots': return doc.lotStore.get(id);
    default: return undefined;
  }
}
