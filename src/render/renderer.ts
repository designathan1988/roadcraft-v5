import { onMap } from '@world/cityGen/wholeMap';
import type { FarTiles } from './buildings/farLevels';
import { jobPort } from '../jobs/jobPool';
import { onEcologyRead } from './ecologyPool';
import { GRID_CELL } from '@world/grid';
import type { BodyPart, Severable } from '@sim/people/view';
import type { Archetype } from '@sim/vehicles/archetypes';
import { pointInPolygon } from '@core/polygon';
import type { Occupant, RagdollProbe } from './ragdoll';
import type { PlayEffects } from './playEffects';
import { createLotOverlay, type LotOverlayInput } from './lotOverlay';
import { onCarriageway } from '@world/carriageway';
import {
  BufferGeometry,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Float32BufferAttribute,
  Color,
  ACESFilmicToneMapping,
  PointLight,
  Group,
  Frustum,
  Box3,
  Matrix4,
  type Material,
  Mesh,
  MeshDepthMaterial,
  type Object3D,
  RGBADepthPacking,
  Sphere,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Digest } from '@core/digest';
import type { Change, ChangeJournal, ChangeKind, ChangeRect, DerivedChangeKind } from '@world/changes';
import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import { Network, type SegmentRibbon } from '@world/network';
import { GROUND_ONLY, SURFACE_READ_REACH, buildRoadElevation, roadsToRead, type RoadElevation } from '@world/elevation';
import { RoadsRead } from './roadsRead';
import { RoadStations } from './roadStations';
import { FOOTWAY_RISE, LANE_LINE, sidewalkHalf } from '@world/roadTypes';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';
import { type PavingData, type PavingSource, pavedHeightFrom } from '@world/paving';
import type { RoadStructure } from '@world/structures';
import { TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT } from '@world/terrain';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import type { GroundBox } from '@sim/host/fleetGrid';
import type { Viewport } from '@view/viewport';

import { VEHICLE_REACH, createAgentMeshes, type AgentMeshes } from './agents';
import { frustumGroundBox } from './frustumGround';
import { createEnvironment, sunShadowChunks } from './environment';
import type { Movers } from './sunCascades';
import { createMaterials, type SceneMaterials } from './materials';
import { PERSPECTIVE_FOV, createIsoRig } from './isoViewport';
import { renderTargetsBytes } from './targetBytes';
import { deviceGpuCap, gpuLedger, readGpuDevice } from './gpuLedger';
import { WEAK_MACHINE } from '@core/weakMachine';
import { DEFAULT_ATMOSPHERE, createPostChain, type Atmosphere, type PostChain } from './postprocess';
import { createInspector, type Inspector } from './inspector';
import { buildRoadSurfaces, disposeSurfaceReuse, dropSurfaceBlocks, noRoadSurfaces, passLook, roadSurfaceSteps, surfaceLook, type RoadSurfaces, type SurfaceReuse, type TileBundle } from './roadSurfaces';
import { SurfaceInputs } from './roadSurfaceInputs';
import { forgetDerivedKeys, forgetOtherDerived, readDerivedKeys, readDerivedSome, writeDerivedMany } from './derivedCache';
import { DerivedWriterLane } from './derivedWriterLane';
import { disposeMesh } from './mesh/surfaceMesh';
import { RoadTilePool } from './roadTilePool';
import { GroundShapePool } from './groundShapePool';
import { type BlockDigestAsk, type GroundShapeAsk, type PadsAsk, type PlateShapeAnswer, blockDigest, cornerBoxes, shapeGroundAsk } from './groundShape';
import type { Pad } from '@world/buildings/pads';
import { refOf } from '@world/buildings/recordTable';
import { shapeBoth } from './terrainShaping';
import { PLANT_MAP_ZOOM, PLANT_NEAR_ZOOM, createSceneryKit, plantSamples, type SceneryKit } from './scenery';
import { createStreetFurniture } from './streetFurnitureLayer';
import { createGardens, gardenPlants, type Gardens } from './gardens';
import { gardenLists } from './gardenLists';
import { solidFootprints, storedBounds } from '@world/buildings/geometry';
import { RoadDoc } from '@world/doc';
import { compileAhead, drainCompiles, drainUploads, drainWarm, gateUntilBuilt, shadowStandIn, warmPending } from './uploads';
import { partWarmMeshes } from './buildings/partWarm';
import { advanceWind, setWindWeather, sways } from './wind';
import { holdStill, updateMoving } from './stillTree';
import { castCastersInto } from './shadowCasters';
import { setShadowSun } from './cellInstances';
import { createRain } from './rain';
import { createLightning } from './lightning';
import { windVector } from '@world/weather';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails } from './structures';
import { type StructureCells, createStructureCells } from './structureCells';
import { createExhaust } from './exhaust';
import { applyWear, createWearField } from './wear';
import { PLATE_SIZE, platesOver, plateRegion } from '@world/bounds';
import { createSignLayer } from './signLayer';
import { type PlantCells, createCoverCells, createTreeCells } from './plantCells';
import { paintCatalogue } from './markings';
import { isNear, updateRoadLevels } from './mesh/roadResidency';
import { JournalCursor } from '@world/derived';
import { RoadStandIn } from './roadStandIn';
import { Engine } from '@core/engine';
import { fadeMeshes } from './buildings/fade';
import { RevealGate } from './revealGate';
import { createShaderCatalogue } from './shaderCatalogue';
import { personProgramStandIns } from './people/proceduralCrowd';
import { createGpuTimer, type GpuTimer } from './gpuTimer';
import { poleGroundAt, type Utilities } from './utilities';
import { type PoleLayer, buildPolePreview, buildUtilities, docPoles, type PolePreviewInput } from './poleLayer';
import { createBarriers } from './barriers';
import { buildTrackPreview, createTrackPreview, createTransit, type TrackPreview } from './transit';
import { TERRAIN_CELL, TERRAIN_GRID, TERRAIN_HALF, type TerrainPart, type TerrainRegion, type TerrainSurface } from './terrain';
import { createFlatAtlas } from './flatAtlas';
import { FarRoads } from './farRoads';
import { NearTiles } from './nearTiles';
import { poleProduct } from './poleTiles';
import { furnitureProduct } from './furnitureTiles';
import { signProduct } from './signTiles';
import { barrierProduct } from './barrierTiles';
import { plantedProduct } from './plantedTiles';
import { structureProduct } from './structureTiles';
import { gardenProduct } from './gardenTiles';
import { coverExtraFor, coverProduct } from './coverTiles';
import { elementProduct } from './elementTiles';
import type { SharedGroundAt, SharedGroundData } from './sharedGround';
import type { FarTileBake } from '../cityTile.worker';
import { WOODS_SPACING } from './woodsBase';
import { siteGrading } from '@world/buildings/siteGrading';
import { type CameraSolids, type GroundSince, cameraSolidsKeeper } from '@world/buildings/cameraSolids';
import { buildingFloors } from '@world/buildings/floors';
import { FLOOR_READ_REACH } from '@world/buildings/foundation';
import { RoomLamps } from './roomLamps';
import { TUNED_UNIT, m, perM } from '@world/units';
import { VIEW_BUDGETS, type CityView } from '@core/perfBudget';
/** Room lights kept in the scene for the floors cut open (`roomLamps.ts`). */
const ROOM_LIGHTS = 6;
declare const __ROAD_TILES_HASH__: string | undefined;
/** The fingerprint of the road tiles' code (`cook-plugin.ts`): their tiles are kept under it between sessions. */
const ROAD_TILES_HASH = typeof __ROAD_TILES_HASH__ !== 'undefined' && __ROAD_TILES_HASH__ ? __ROAD_TILES_HASH__ : null;
/** How long the opening's roads wait for the kept tiles to be read, ms: past it they are built. */
const KEPT_TILES_WAIT_MS = 3000;
/** The view a zoom belongs to, for its budgets (`core/perfBudget.ts` `VIEW_BUDGETS`): the street from 8 px a metre, the district from 0.8, the map under. */
const STREET_ZOOM = perM(8);
const DISTRICT_ZOOM = perM(0.8);
const viewOf = (zoom: number): CityView => (zoom >= STREET_ZOOM ? 'street' : zoom >= DISTRICT_ZOOM ? 'district' : 'map');
/** Frames in a window of the GPU's time read by the governor (`buildings/frameBudget.ts` `TimeGovernor`). */
const GOVERN_FRAMES = 30;

import { type BuildingPreviewInput, type CutawaySpec, createBuildingLayer } from './buildings/layer';
import { TimeGovernor } from './buildings/frameBudget';
import { buildBuildingMeshes } from './buildings/buildingMesh';
import { refillArrays } from './mesh/gpuOnly';
import { wantAllTexels } from './surfaceTextures';
import { BLUEPRINTS, instantiate } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { QUALITY, QualityGovernor, type QualityLevel, type QualitySettings } from './quality';
import { type GroundRecord, type Rect, unionRect } from './groundChanges';
import { FOREST_SPECIES, createGroundCoverKit } from './groundCover';
import type { PlantedTree } from '@world/trees';
import { ClearingCells } from './clearingCells';
import { buildNatureForest, loadNatureTrees, seedOfKind, type NatureTreeKit } from './natureTrees';
import { createFogField, createFogTexture, type FogLayer } from './fogLayer';
import { createElementLayer, loadElementKit, type ElementKit, type ElementLayer } from './elements';
import { isCoverKind } from '@world/terrainPaint';
import { CellKeeps, keepCellAt, keepCellRect, keepCellsOver } from './cellKeeps';
import { ActiveTiles } from './activeTiles';
import { measureHitch } from '@core/hitch';
import { TILE, tileKeyAt, tileOfKey } from '@world/tiles';
import { createDensityCars } from './densityCars';
import { COVER_SWEEP_PAD, ShorePlates, cellHash, forestIn, rocksIn, sameCandidate, sameShore, scrubIn, shoreIn, type Candidate, type CoverField, type ShoreCandidate } from './coverSweep';
import { PlateFollow } from './plateFollow';

/** The scene renderer. ## The rebuild contract Everything derived from the road network or the terrain is rebuilt in */

/** How the sky is kept: `cycle` follows the residents' clock. */
export type SkyMode = 'day' | 'night' | 'cycle';


/** What an explosion broke, for the renderer to throw (`blast.ts`): world coordinates. */
export interface BlastHit {
  readonly ground: 'road' | 'earth' | 'building';
  readonly crater: boolean;
  readonly poles: readonly { x: number; y: number; lamp: boolean; mode: 'whole' | 'snap' | 'splinter'; dirX: number; dirY: number }[];
  /** Wires torn off a broken pole: from the pole still standing towards the one that went. */
  readonly wires: readonly { fromX: number; fromY: number; toX: number; toY: number }[];
  readonly posts: readonly { x: number; y: number; yaw: number }[];
  /** `id` and `archetype`: which vehicle, for a wreck of its own body (`AgentMeshes.carcass`). */
  readonly vehicles: readonly { x: number; y: number; angle: number; length: number; width: number; height: number; color: number; id?: number; archetype?: Archetype }[];
  readonly items: readonly { kind: string; x: number; y: number }[];
}

interface RenderStats {
  /** Built scene geometry budget; `gl.info.render.triangles` counts drawn passes. */
  readonly triangles: number;
  /** Actual draw calls across every pass of the last game frame. */
  readonly drawCalls: number;
  readonly quality: QualityLevel;
  readonly fps: number;
  /** Wall time of the last world rebuild, in milliseconds. */
  readonly rebuildMs: number;
  /** The road surface tiles the last rebuild made afresh, and those it kept. */
  readonly roadTiles?: { readonly built: number; readonly reused: number };
  /** Increments once per completed world rebuild. */
  readonly rebuilds: number;
  /** Wall time of the last terrain-only update (a brush dab while roads are held), ms. */
  readonly terrainMs: number;
}

interface DrawOptions {
  /** Keep the roads, and everything laid along them, as they are */
  readonly holdRoads?: boolean;
}

export interface SceneHandle {
  /** Loads what shots and blows leave behind */
  effects(): Promise<void>;
  /** The world of the last edit is still being built (`worldSteps`); the old one is drawn meanwhile. */
  readonly worldBusy: boolean;
  /** The opening's town (or a map being opened) is still being put together, nothing of it shown yet (`opened` in `draw`). */
  readonly opening: boolean;
  /** Settles once the programs of this opening are compiled (`shaderCatalogue.ts`): the curtain stays up until then. */
  readonly programsReady: Promise<void>;
  /** A map is being opened (a file, the autosave): nothing is shown until its whole world is in */
  beginLoad(): void;
  /** What else the opening waits for besides the town drawn: the tiles round the camera come in (`worldStreamer.ts` settled); null: nothing. */
  holdOpening(until: (() => boolean) | null): void;
  /** The streamed world's active tiles (`worldStreamer.ts` isActive): the buildings and the roads of the kept ring beyond are not put together here, the far levels draw them (`BuildingLayer.setActive`, `SurfaceReuse.within`). */
  setActiveTiles(at: ((x: number, y: number) => boolean) | null, rects: readonly ChangeRect[]): void;
  /** A tile put in the document or come into the active region: its near products not drawn yet (`nearDrawn` false) until its roads are built and its buildings' cells have something drawn; then `onNearDrawn` (DO NOT let its far level go before: holes with shadows). */
  tileLoaded(key: number, rect: ChangeRect, revision: number): void;
  tileLetGo(key: number): void;
  nearDrawn(key: number): boolean;
  /** How far round the eye the far levels are drawn now (`FarTree.reachNow`; 0 before the first choice): the tiles the opening waits for. */
  readonly farReach: number;
  /** Whether the view the far levels were last chosen in sees a square of the plan (x0, y0)-(x1, y1), from under the ground to 500 m (`farTree.ts` inView before a node lands): the tiles the opening waits for. */
  readonly farSees: (x0: number, y0: number, x1: number, y1: number) => boolean;
  onNearDrawn: ((key: number) => void) | null;
  /** The buildings of the tiles not in the page's document, baked per tile from the tile store (`buildings/farLevels.ts`). */
  readonly farBuildings: FarTiles;
  /** The roads of the tiles not in the page's document, baked per tile from the tile store (`farRoads.ts`). */
  readonly farRoads: FarTiles;
  /** What a tile's maker bakes its far levels with (`cityTile.worker.ts`): the ground and tones the far trees' jobs read now and the keys they keep a tile's level 0 under. */
  farBakeEnv(): FarTileBake;
  readonly backend: 'three-webgl';
  readonly viewport: Viewport;
  readonly scene: Scene;
  /** The underlying WebGL renderer. Exposed for diagnostics and tests. */
  readonly gl: WebGLRenderer;
  readonly stats: RenderStats;
  /** The GPU time of each frame drawn (`gpuTimer.ts`): the F9 monitor and the performance gate read it. */
  readonly gpu: GpuTimer;
  /** The solved road height field, for the editor's own previews. */
  elevationAt(x: number, y: number, structure?: RoadStructure): number;
  /** The editor's building ghost; null removes it. */
  setBuildingPreview(preview: BuildingPreviewInput | null): void;
  /** The pole run the pole tool would build, drawn as built; null removes it. */
  setPolePreview(net: Network, preview: PolePreviewInput | null): void;
  /** The metro seen as a cut through the ground (the transit tool on). */
  setTransitXray(on: boolean): void;
  /** The track being laid, built as it will be (`buildTrackPreview`); null removes it. */
  setTransitPreview(preview: { mode: 'train' | 'metro'; points: readonly { x: number; y: number }[] } | null): void;
  /** The lots of the Zoning tool coloured into the ground, all of them from the next frame (`lotOverlay.ts`) */
  setLotOverlay(input: LotOverlayInput | null, changes?: ChangeJournal): void;
  /** A blow on a building at world (x, y, z), `strength` 1..10: it breaks (`destruction.ts`). */
  strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
  /** A blow on the street at (x, y): a crater in the asphalt, dust. */
  strikeGround(x: number, y: number, strength: number): void;
  /** An explosion at world (x, y), height z, reaching `radius` (`blast.ts`), and the things it broke. */
  explode(x: number, y: number, z: number, radius: number, hit: BlastHit): void;
  /** People inside a struck building, thrown out of it (`ragdoll.fling`). */
  flingOccupants(list: readonly Occupant[]): void;
  /** Called when a struck building comes down after its blow (its pieces were made off the main thread). */
  onBuildingDown(listener: (id: number) => void): void;
  /** A broken hydrant spouting water (`blast.geyser`). */
  geyser(x: number, y: number, z: number, seconds?: number): void;
  /** A burst pipe: a small spout of water from a wall for a moment. */
  leak(x: number, y: number, z: number, seconds: number): void;
  /** Sparks of a short circuit at world (x, y), height z, for a while (`blast.arc`). */
  sparkAt(x: number, y: number, z: number, seconds: number): void;
  /** Soot laid on the ground (`blast.soot`). */
  soot(x: number, y: number, z: number, radius: number): void;
  /** Smoke in the air, 0 clear to 1 thick: the fog closes in, browner, the light dims. */
  setSmog(k: number): void;
  /** A lightning bolt onto the map point (x, y) now (`render/lightning.ts`). */
  strikeAt(x: number, y: number): void;
  /** Called at every strike with where it fell and how far from the view's centre, world units (for the thunder). */
  onStrike(listener: (x: number, y: number, distance: number) => void): void;
  /** How far the wind has carried the clouds, on the map (`world/clouds.ts` driftedCloud). */
  cloudDrift(): { readonly x: number; readonly y: number };
  /** A lasting fire at world (x, y), height z (a building burning). */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** Whether anything is still moving on its own (an explosion, bodies, debris): keep drawing. */
  busy(): boolean;
  /** Clouds drifting over the map: worth a frame now and then even with nothing else moving. */
  drifting(): boolean;
  /** The bytes of the render targets and shadow maps alive (an estimate, `targetBytes.ts`): not in the scene, so not in `countMemory`. */
  targetBytes(): number;
  /** The bytes the buildings' detail holds on the GPU now (within the room the GPU ledger's cap leaves, `gpuLedger.ts`). */
  buildingDetailBytes(): number;
  /** Forgets a building's ruin (it was removed). */
  forgetRuin(id: number): void;
  /** The Builder's "Ocultar outros": undefined draws every building solid, null fades them all */
  setBuildingsDimmed(except: number | null | undefined): void;
  /** "See inside": the buildings near (x, y) drawn cut open at a floor; null draws them whole. */
  setBuildingCutaway(spec: CutawaySpec | null): void;
  /** The sky: always day, always night, or the residents' own clock. */
  setSkyMode(mode: SkyMode): void;
  /** Clouds and mist as the player set them (Landscape > Sky and weather). */
  setAtmosphere(atmosphere: Atmosphere): void;
  /** Perspective camera on, or the orthographic (isometric) view. */
  setPerspective(on: boolean): void;
  /** A shot: a tracer from the muzzle to where it struck, and the muzzle's flash (world x, y, height). */
  shot(from: readonly [number, number, number], to: readonly [number, number, number]): void;
  /** A person struck by a shot (world x, y, the height struck) */
  wound(x: number, y: number, z: number, dirX: number, dirY: number, severed: Severable | null): void;
  /** A shot along the line of sight between world points `a` and `b` (x, y, height) at the bodies on the ground */
  shootBody(a: readonly [number, number, number], b: readonly [number, number, number]): { alive: number; part: BodyPart } | 'hit' | null;
  /** Whether somebody is down on the ground as a body (not standing to be shot). */
  isDown(id: number): boolean;
  /** The bodies, guts and debris run at this share of real time (0: stopped; the weapons lab). */
  setEffectsSpeed(speed: number): void;
  /** Moves the bodies, guts and debris on by `seconds` once (a frame step while stopped). */
  stepEffects(seconds: number): void;
  /** Every body, piece, gut and blood stain gone (the weapons lab's clean slate). */
  clearCasualties(): void;
  /** Every body on the ground as the weapons lab measures it (`Ragdolls.probe`). */
  ragdollProbe(): RagdollProbe[];
  /** What poses a person now (`AgentMeshes.animProbe`). */
  animProbe(id: number): ReturnType<AgentMeshes['animProbe']>;
  /** Plays a clip on a person regardless (`AgentMeshes.forceClip`). */
  forceClip(id: number, clip: string | null): void;
  /** Every procedural person's skeleton measured against their body (`AgentMeshes.meshProbe`). */
  meshProbe(): ReturnType<AgentMeshes['meshProbe']>;
  /** A shot striking a vehicle at world (x, y, height z), coming along (dirX, dirY) */
  vehicleHit(x: number, y: number, z: number, dirX: number, dirY: number, glass: boolean, blood: boolean): void;
  /** The body a vehicle's driver or rider is drawn with (`AgentMeshes.driverBody`). */
  driverBody(vehicle: VehicleView, x: number, y: number): number | null;
  /** A two-wheeler its rider was shot off: the machine itself falling over and sliding to a stop. */
  dropVehicle(v: { id: number; archetype: Archetype; x: number; y: number; angle: number; color: number; dirX: number; dirY: number }): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /** The highest corner of the ground as drawn now (the mesh is flat between corners), read once per change of it. */
  landTop(): number;
  /** The universal grid (`world/grid.ts`) drawn over the whole map, on the ground, or not. */
  setGrid(on: boolean): void;
  /** The grid's cells a road was just laid over light up and fade back, a blink */
  flashGrid(cells: readonly { x: number; y: number; ring: number }[]): void;
  /** The roads just laid light up and fade back, a blink, over their whole width. */
  flashRoads(ids: readonly SegmentId[]): void;
  /** The ground what is built stands on (`builtGroundAt`) */
  builtGroundAt(x: number, y: number): number;
  /** The roads' heights an edit already solved for this network on the natural terrain (the tunnel test, `commitRoadPath`) */
  offerElevation(elevation: RoadElevation, networkRevision: number): void;
  /** The roads' heights last solved on the natural terrain, with the terrain revision they were solved on */
  roadsSolve(): { readonly elevation: RoadElevation; readonly terrainRevision: number } | null;
  /** The top of what is drawn at a point: a deck where a road's casing covers it, the terrain elsewhere. */
  surfaceHeightAt(x: number, y: number): number;
  /** The height of the paving at a point (NaN off the roads); with `pack`, what a worker reads it from over a rectangle (`world/paving.ts`). */
  readonly pavedHeightAt: PavingSource;
  resize(): void;
  draw(net: Network, sim: SimClient, alpha: number, delta: number, options?: DrawOptions): void;
  /** A tier, or the player's own settings on it (the options panel: shadows, occlusion, smoothing). */
  setQuality(level: QualityLevel | 'auto', settings?: QualitySettings): void;
  readonly quality: QualityLevel | 'auto';
  /** The inspection camera (`inspector.ts`); null outside development builds. */
  readonly inspect: Inspector | null;
  /** Every figure drawn last frame and the body it was cast as: the runtime census. */
  census(): ReturnType<AgentMeshes['census']>;
  dispose(): void;
}

/** Roads at grade, and the decks above them, as `surfaceHeightAt` asks them. */
const SURFACE_SETS: readonly ReadonlySet<RoadStructure>[] = [GROUND_ONLY, new Set<RoadStructure>(['elevated', 'bridge'])];

/** A plant's leaf cards (`scenery.ts` `plantMeshes`, `gardens.ts`): `...-trees-<species>-cards`, `...-bushes-<kind>-cards`. */
const isLeafCards = (mesh: Object3D): boolean => mesh.name.endsWith('-cards');

/** The vertices of the first mesh drawn under `root` (visible itself), 0 when none is: stops at the first, never counts them all. */
function firstDrawnVertices(root: Object3D): number {
  const stack: Object3D[] = [root];
  while (stack.length) {
    const o = stack.pop()!;
    const mesh = o as Mesh;
    if (mesh.isMesh && mesh.visible) {
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      if (count > 0) return count;
    }
    for (const child of o.children) stack.push(child);
  }
  return 0;
}

export function createSceneRenderer(
  canvas: HTMLCanvasElement,
  initialCentre: Vec2,
  initialZoom: number,
  initialQuality: QualityLevel | 'auto' = 'auto',
  askDraw: () => void = () => {},
  /** The engine the scene's products are registered with (`core/engine.ts`): the game's one, from `main.ts`. */
  engine: Engine = new Engine(),
  /** The player's own settings on the tier (the options panel); the tier's own when absent. */
  initialSettings?: QualitySettings,
): SceneHandle {
  /** Something landed or asked for a frame since the last shadow pass: the casters kept still in the sun's stores may have changed (`ShadowPassInput.still`). */
  let castersStirred = true;
  const stir = (): void => { castersStirred = true; };
  const onAssetsReady = (): void => { stir(); askDraw(); };
  // A plate's ecosystem read off the page (`ecologyPool.ts`) is drawn as it comes back.
  onEcologyRead(onAssetsReady);
  /** The shadow map is drawn only when it can have changed. */
  let shadowMoved = true;
  /** Whether the simulation runs: what it moves moves (`environment.setMovers`). */
  let simRunning = false;
  /** DO NOT walk the scene for it each frame: whether anything that moves is drawn into the shadow map, as the layers that move it say */
  const movingCasters = (): boolean => agents.casting || transit.moving || (fx?.busy() ?? false);
  /** Moving casters in the last shadow frame: when they stop, the map is drawn once more with them at rest. */
  let castersMoved = false;
  /** The camera at the last shadow pass: a view moved re-culls the instanced layers, the casters kept still are not those (`ShadowPassInput.still`). */
  const shadowView = new Matrix4(), shadowProjection = new Matrix4();
  let shadowScale = Number.NaN;
  /** Whether the opening's quality draws through the post chain: its canvas then takes only the output pass, so it is made without multisampling or depth (the chain's scene target has its own). */
  const canvasForChain = (initialSettings ?? QUALITY[initialQuality === 'auto' ? 'high' : initialQuality]).postProcessing;
  const renderer = new WebGLRenderer({
    canvas,
    // A quality without the chain chosen later draws through a multisampled target of its own (`postprocess.ts` plainChain).
    antialias: !canvasForChain,
    depth: !canvasForChain,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    // DO NOT drop it for a near plane pushed out or offsets grown until the flicker hides.
    reversedDepthBuffer: true,
  });
  // One game frame has the scene, shadows and several postprocess renders.
  renderer.info.autoReset = false;
  // Checking every program's compile and link log makes each new shader wait for the driver on the main thread
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  // The GPU time of every frame.
  const gpuTimer = createGpuTimer(renderer);
  renderer.outputColorSpace = SRGBColorSpace;
  // A film curve (ACES): contrast, deep shade and bright light, the look of the diorama the player holds up as the target
  renderer.toneMapping = ACESFilmicToneMapping;
  // Three's ACES already scales its input by 1 / 0.6
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was REMOVED in three r186.
  renderer.shadowMap.type = PCFShadowMap;
  sunShadowChunks();
  // Drawn once a frame, on request (see `post.render` below).
  renderer.shadowMap.autoUpdate = false;

  // One shadow depth material per program variant. three draws every caster without a depth material of its own with ONE
  // DO NOT write the colour: the sun's maps are read by their depth (PCF compares the depth texture, `sunCascades.ts`), nothing reads the packed colour.
  const depthVariants = {
    plain: new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false }),
    instanced: new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false }),
    tinted: new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false }),
  };
  // DO NOT write colour into the shadow map: it is sampled by its depth texture alone (three r186 `WebGLShadowMap`, PCF: `shadow.map.depthTexture` with a compare function), the RGBA target written for nothing every caster, every cascade.
  for (const depth of Object.values(depthVariants)) depth.colorWrite = false;
  const ownDepth = new Set<MeshDepthMaterial>(Object.values(depthVariants));
  const plainOpaque = (material: Material): boolean => {
    const m = material as Material & { alphaTest: number; alphaMap?: unknown; map?: unknown; displacementMap?: unknown };
    // Anything three would give a depth material of its own (cut-outs, displacement, coverage) keeps three's own choice.
    return !(m.alphaTest > 0 && (m.map || m.alphaMap)) && !m.displacementMap && !m.alphaToCoverage;
  };
  /** DO NOT walk the scene for it (every 30 frames it walked every object): a mesh is given its variant's depth material as it comes in */
  const depthFor = (object: Object3D): void => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
    // Whether it casts or not: a mesh switched to casting later (the two-wheelers) has its material already.
    if (!mesh.isMesh) return;
    const current = mesh.customDepthMaterial as MeshDepthMaterial | undefined;
    if (current && !ownDepth.has(current)) return;
    if (Array.isArray(mesh.material) || !plainOpaque(mesh.material)) return;
    const wanted = !mesh.isInstancedMesh
      ? depthVariants.plain
      : mesh.instanceColor ? depthVariants.tinted : depthVariants.instanced;
    if (current !== wanted) mesh.customDepthMaterial = wanted;
  };
  /** Every container under `root` told of what is added to it (three's `childadded`), and what is there now given its depth material. */
  const watchedForDepth = new WeakSet<Object3D>();
  const watchShadowDepth = (root: Object3D): void => {
    root.traverse((object) => {
      depthFor(object);
      noteSway(object, true);
      if ((object as Mesh).isMesh || watchedForDepth.has(object)) return;
      watchedForDepth.add(object);
      object.addEventListener('childadded', onChildAdded);
      object.addEventListener('childremoved', onChildRemoved);
    });
  };
  // What comes into the scene or leaves it changes what casts: the sun's stores are not used for that frame (`castersStirred`).
  // And through the one door into the drawn scene: held off the drawn layers until its programs are built (`uploads.ts` gateUntilBuilt).
  // DO NOT stir the sun's stores for what comes or goes under a mover (people, vehicles, trains): never in a store, drawn over it every frame (`sunCascades.ts` movers); people walking into view stirred them every frame of a still view (`__stillLog`, 2026-10-17).
  const onChildAdded = (event: { child: Object3D; target?: Object3D }): void => {
    const casts = !inMover(event.target);
    if (casts) stir();
    watchShadowDepth(event.child);
    // Out of the door into the drawn layers: a caster from now on (`uploads.ts` gateUntilBuilt).
    gateUntilBuilt(event.child, casts ? stir : undefined);
  };
  const onChildRemoved = (event: { child: Object3D; target?: Object3D }): void => {
    if (!inMover(event.target)) stir();
    event.child.traverse((o) => noteSway(o, false));
  };
  /** The roots of what moves (`environment.setMovers`): what is under them is drawn over the stores, never kept in them. */
  const moverRoots = new Set<Object3D>();
  const inMover = (object: Object3D | undefined): boolean => {
    for (let o = object; o; o = o.parent ?? undefined) if (moverRoots.has(o)) return true;
    return false;
  };
  /** What the wind sways in the shadow (`wind.ts` markSway on its depth material: trees, grass, impostors, scenery; flags, wires and signal posts cast at rest), mesh by mesh: a mover of the sun's cascades (`sunCascades.ts`), drawn over their store of what stands still. */
  const swayMeshes = new Set<Object3D>();
  let swayList: Object3D[] = [];
  let swayChanged = false;
  const noteSway = (object: Object3D, on: boolean): void => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if (on) {
      // Its shadow is drawn with its depth material: only one the wind moves sways there.
      if (!mesh.customDepthMaterial || !sways(mesh.customDepthMaterial)) return;
      if (swayMeshes.has(mesh)) return;
      swayMeshes.add(mesh);
    } else if (!swayMeshes.delete(mesh)) return;
    swayChanged = true;
  };
  const swaying: Movers = {
    get roots() {
      if (swayChanged) { swayList = [...swayMeshes]; swayChanged = false; }
      return swayList;
    },
    // The wind is never still (`wind.ts` uWindStrength): what it sways moves every frame.
    moving: () => true,
    fixedSize: true,
  };

  let requested: QualityLevel | 'auto' = initialQuality;
  const governor = new QualityGovernor(requested === 'auto' ? 'high' : requested);
  let quality: QualitySettings = initialSettings ?? QUALITY[governor.current];

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = Math.min(quality.anisotropy, maxAnisotropy);

  let gridWanted = false;
  /** The blinks of cells under a road just laid (`flashGrid`), until each has faded; `time` seconds since each began. */
  const gridFlashes: { mesh: Mesh; start: number; end: number; time: number }[] = [];
  /** ONE material for every blink, made once: a material per road laid was an object made and disposed per edit */
  const blinkMaterial = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aRing; varying float vRing;
        void main() {
          vRing = aRing;
          vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform float uTime; varying float vRing;
        void main() {
          float t = uTime - vRing * 0.09;
          float a = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.1, 0.75, t)) * (vRing < 0.5 ? 0.3 : 0.12);
          if (a <= 0.001) discard;
          gl_FragColor = vec4(0.62, 0.95, 1.0, a);
        }`,
      // Over the ground whatever it does meanwhile
      transparent: true, depthWrite: false, depthTest: false, side: DoubleSide, blending: AdditiveBlending,
  });
  /** A blink on the ground: triangles (three's x, height, -y) lighting up and fading, each by its ring's delay. */
  const addBlink = (pos: readonly number[], ring: readonly number[]): void => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geometry.setAttribute('aRing', new Float32BufferAttribute(ring, 1));
    const mesh = new Mesh(geometry, blinkMaterial);
    mesh.name = 'grid-flash';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const flash = { mesh, start: performance.now(), end: 0.8 + Math.max(0, ...ring) * 0.09, time: 0 };
    mesh.onBeforeRender = () => {
      blinkMaterial.uniforms['uTime']!.value = flash.time;
      blinkMaterial.uniformsNeedUpdate = true;
    };
    scene.add(mesh);
    gridFlashes.push(flash);
  };
  /** Roads just laid, to blink once their heights are solved (`flashRoads`, `draw`). */
  const pendingRoadFlash: SegmentId[] = [];
  const scene = new Scene();
  watchShadowDepth(scene);
  // The root never moves.
  scene.matrixAutoUpdate = false;
  scene.updateMatrix();
  // DO NOT let three walk the whole scene in every pass drawn (scene, normals, shadows): the frame updates what moves once (`updateMoving`), the still trees place what enters them.
  scene.matrixWorldAutoUpdate = false;
  const initialHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
  /** The canvas's CSS size, kept by a ResizeObserver: DO NOT read clientWidth or clientHeight in the frame (each read forces a layout when anything on the page moved). */
  const css = { w: canvas.clientWidth, h: canvas.clientHeight };
  const sizeWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    css.w = canvas.clientWidth;
    css.h = canvas.clientHeight;
    // A frame for the new size, however still the game stands.
    onAssetsReady();
  });
  sizeWatch?.observe(canvas);
  /** Where the relief's close window is centred (three's x, z; see `draw`). */
  const reliefFocus = { x: 0, z: 0 };
  const rig = createIsoRig(initialCentre, initialHeight / Math.max(0.001, initialZoom * 2));

  const environment = createEnvironment(scene, renderer, {
    shadows: quality.shadows,
    shadowMapSize: quality.shadowMapSize,
  });
  const materials: SceneMaterials = createMaterials(anisotropy);
  // Streets and footways wear with use (`wear.ts`).
  const wear = createWearField();
  let lastWall = -1;
  applyWear(materials.asphalt, wear, 0, 'asphalt');
  applyWear(materials.footway, wear, 1, 'footway');
  materials.setDetail(quality.surfaceDetail);
  // Every prop model and material, built once.
  const sceneryKit: SceneryKit = createSceneryKit();
  // The map's ground, in plates (`flatAtlas.ts`).
  const terrain: TerrainSurface = createFlatAtlas(anisotropy);
  /** The ground what is built stands on - the roads solved on it, the buildings' floors worked out on it */
  const builtGroundAt = (x: number, y: number): number => terrain.naturalRenderedHeightAt(x, y);
  // The perspective view looks at the ground and stays over it (`IsoRig.setGround`).
  rig.setGround((x, y) => terrain.renderedHeightAt(x, y));
  // DO NOT make it again unseen.
  if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __gl: renderer });
  scene.add(...terrain.meshes);

  const world = new Group();
  world.name = 'world';
  // DO NOT let the world's group compose its matrix every frame: three then forces every descendant (thousands of blocks, cells and far meshes) to multiply its world matrix again in every pass (`Object3D.updateMatrixWorld` force).
  world.matrixAutoUpdate = false;
  // Roads, plants, poles, furniture, forests: placed once, never moved (`stillTree.ts`).
  holdStill(world);
  scene.add(world);
  /** The roads of the tiles not in the page's document (`farRoads.ts`), on the ground shared with the workers. */
  const farRoadGround = (): SharedGroundData | null => (terrain.renderedHeightAt as SharedGroundAt).share?.current ?? null;
  // Each tile's near level where the view wants its detail and the region does not draw it (`nearRoadTiles.ts`): the region's look of the roads, the same materials.
  // DO NOT read it off `surfaceReuse`: the near level's programs are made with the far roads (`farRoads.ts` stand-ins), before it is declared (the page did not open, 2026-10-17).
  const roadPaint = paintCatalogue();
  const nearPaintFor = (color: string): Material => roadPaint.get(color) ?? roadPaint.get(LANE_LINE) ?? materials.asphalt;
  /** The buildings put on the ground once (`buildings.update`): the near roads are baked on the ground they read, known from then. */
  let buildingsGrounded = false;
  const farRoads = new FarRoads(farRoadGround, undefined, undefined, {
    look: () => passLook(materials, terrain.vergeMaterial),
    markingStyle: () => worldNet?.doc.markingStyle ?? 'classic',
    naturalIsGround: () => buildings.farEnv().naturalIsGround,
    dress: (source, raised) => surfaceLook(source, raised, materials, terrain.vergeMaterial, nearPaintFor),
    // DO NOT put the view's near roads behind the curtain's masses: the curtain waits for them (`whole`).
    coarseFirst: () => false,
    ready: () => buildingsGrounded,
  });
  world.add(farRoads.group);
  /** A road just built drawn at once (`roadStandIn.ts`) until its tile's near roads come back from their worker: the diary's road edits read for it, the tiles' loads left out. */
  const roadStandIn = new RoadStandIn();
  world.add(roadStandIn.group);
  /** The roads the tool just laid (`flashRoads`: the player's road alone, never the street it meets split at the new junction), stood in once their heights are solved. */
  const pendingStandIn: SegmentId[] = [];
  /** The streamed world's near products per tile, chosen by the view and baked in workers from the store (`nearTiles.ts`): the poles and wires (`poleTiles.ts`). */
  const nearTiles = new NearTiles();
  nearTiles.add(poleProduct(sceneryKit, world));
  /** The roads' tree and the near products' tiles, told the stored tiles as one (`main.ts` far levels). */
  const roadsAndNear: FarTiles = {
    setSource: (source, isLoaded) => { farRoads.setSource(source, isLoaded); nearTiles.setSource(source, isLoaded); },
    stored: (key, version) => { farRoads.stored(key, version); nearTiles.stored(key, version); },
    loadedChanged: (key) => { farRoads.loadedChanged(key); nearTiles.loadedChanged(key); },
    setErrorScale: (scale) => { farRoads.setErrorScale(scale); nearTiles.setErrorScale(scale); },
    get bakePrefix() { return farRoads.bakePrefix; },
  };
  /** The streamed world's active tiles as the near products read them (`activeTiles.ts`, `setActiveTiles`): the kept ring's items are the far levels'. */
  const activeTiles = new ActiveTiles();

  let roads: RoadSurfaces | null = null;
  /** The roads' structures, cell by cell (`structureCells.ts`), made with the first world. */
  let details: StructureCells | null = null;
  /** What the player placed on the footways and the long grass, kept item by item from the diary (`streetFurnitureLayer.ts`) */
  const furniture = createStreetFurniture(sceneryKit, activeTiles);
  world.add(furniture.group, furniture.grass);
  let utilities: PoleLayer | null = null;
  /** The pole tool's planned run, and the plan it was built for (rebuilt only when that changes). */
  /** Vehicle exhaust and dust (`exhaust.ts`): one particle cloud for the map. */
  const exhaust = createExhaust();
  scene.add(exhaust.points);
  const shakeOffset = new Vector3();
  /** What shots and blows leave behind - bodies, blood, explosions, broken buildings (`playEffects.ts`) */
  let fx: PlayEffects | null = null;
  let fxLoading: Promise<void> | null = null;
  /** The effects asked for in idle time once the world stands (`draw`). */
  let fxPreload = false;
  // The effects' two lights - the muzzle's flash and the blast's - in the scene from the start, dark until used.
  const fxLights = {
    muzzle: new PointLight(0xffc070, 0, m(8), 2),
    blast: new PointLight(0xffb060, 0, m(60), 1.6),
  };
  scene.add(fxLights.muzzle, fxLights.blast);
  const buildingDownListeners: ((id: number) => void)[] = [];
  const loadEffects = (): Promise<void> => fxLoading ??= import('./playEffects').then((mod) => {
    fx = mod.createPlayEffects({
      scene, exhaust, agents,
      buildings: {
        chunkOf: (b) => buildings.chunkOf(b),
        setRuined: (ruined) => buildings.setRuined(ruined),
        lotHeightAt: (id, x, y) => buildings.lotHeightAt(id, x, y),
      },
      renderedHeightAt: (x, y) => terrain.renderedHeightAt(x, y),
      naturalRenderedHeightAt: (x, y) => builtGroundAt(x, y),
      pavedHeightAt: (x, y) => pavedHeightAt(x, y),
      camera: () => rig.camera,
      onAssetsReady,
      lights: fxLights,
    });
    fx.onBuildingDown((id) => { for (const listener of buildingDownListeners) listener(id); });
    onAssetsReady();
  });
  let polePreview: Utilities | null = null;
  /** Placed signs, street name plates and the junctions' rule plates, kept sign by sign from the diary (`signLayer.ts`). */
  const signs = createSignLayer(activeTiles);
  // The streamed world's furniture and signs per tile (`furnitureTiles.ts`, `signTiles.ts`), in the layers' own cells and sheets: the region makes none of them.
  nearTiles.add(furnitureProduct(furniture, sceneryKit.lens, () => cityMinutes));
  nearTiles.add(signProduct(signs, () => worldNet?.doc.markingStyle ?? 'classic'));
  let polePreviewKey = '';
  /** Walls, fences and hedges (`barriers.ts`), kept barrier by barrier from the diary. */
  const barriers = createBarriers(activeTiles);
  // The streamed world's barriers per tile (`barrierTiles.ts`), in the layer's own cells: the region makes none.
  nearTiles.add(barrierProduct(barriers));
  /** Public transport (`transit.ts`), kept track by track and stop by stop from the diary. */
  const transit = createTransit();
  let elevation: RoadElevation | null = null;
  /** Each rewrite of the drawn ground by the land (`terrain.update`), and the highest corner read after one (`landTop`). */
  let landVersion = 0;
  let landTopFor = -1;
  let landTopValue = 0;

  // What each rebuild keeps for the next
  const tilesPrefix = ROAD_TILES_HASH ? `roadtiles:${ROAD_TILES_HASH}:` : null;
  /** The kept tiles have been read (or there are none to read). */
  let storedRead = tilesPrefix === null;
  /** What the store holds now, by `storedKey`, and by place (`pass|tile`): a tile built again at its place replaces what was kept of it. */
  const storedKeys = new Set<string>();
  const storedAt = new Map<string, string>();
  const placeOf = (key: string): string => key.slice(0, key.lastIndexOf('|'));
  const noteStored = (key: string): void => {
    const place = placeOf(key);
    const was = storedAt.get(place);
    if (was && was !== key && tilesPrefix) { storedKeys.delete(was); forgetDerivedKeys(tilesPrefix, [was]); }
    storedAt.set(place, key);
    storedKeys.add(key);
  };
  /** Where the road tiles are kept for a later session, off the page (`derivedWriter.worker.ts`); none in tests. */
  const tileWriter = tilesPrefix && typeof Worker !== 'undefined'
    ? jobPort('derivedWriter') : null;
  /** Its writes under a ceiling of bytes not yet committed: past it a tile is not kept, made again next time (`DerivedWriterLane`). */
  const tileWrites = tileWriter ? new DerivedWriterLane(tileWriter, 48 * 2 ** 20) : null;
  /** Where the camera looks and how far the roads are at full detail round it (`mesh/roadResidency.ts`). */
  const roadFocus = { x: initialCentre.x, y: initialCentre.y, reach: 700, frames: 0 };
  /** THE GPU'S TIME GOVERNS THE ERROR SCALE'S FLOOR: every `GOVERN_FRAMES` frames, the window's p95 against the view's budget (`VIEW_BUDGETS` gpuMs) asks the floor a step up or down (`BuildingLayer.pressTime`), a step up kept only if it paid (`TimeGovernor`). */
  let governFrames = 0;
  let governView: CityView | null = null;
  const timeGovernor = new TimeGovernor();
  const governFrame = (): void => {
    if (!gpuTimer.supported || ++governFrames < GOVERN_FRAMES) return;
    governFrames = 0;
    const last = gpuTimer.samples.toArray().slice(-GOVERN_FRAMES).sort((a, b) => a - b);
    if (last.length < GOVERN_FRAMES) return;
    const p95 = last[Math.ceil(last.length * 0.95) - 1]!;
    const view = viewOf(rig.viewport.zoom);
    if (view !== governView) { governView = view; timeGovernor.reset(); }
    timeGovernor.read(p95, VIEW_BUDGETS[view].gpuMs, (up) => buildings.frame.press(up));
  };
  const surfaceReuse: SurfaceReuse = {
    tiles: new Map(),
    depends: new Map(),
    // Each pass as the last build left it: a tile put in visits its own road tiles, not the region's (`roadSurfaces.ts` PassState).
    passes: new Map(),
    withinMoved: [],
    dependsOn: (minX, minY, maxX, maxY) => new Digest()
      .add(elevation?.digest(minX, minY, maxX, maxY, SURFACE_READ_REACH) ?? 0)
      .add(terrain.digest(minX, minY, maxX, maxY))
      .value(),
    paint: roadPaint,
    // A block of road is made at full detail only near the camera (`mesh/roadLod.ts`).
    near: (x, y) => isNear(x, y, roadFocus.x, roadFocus.y, roadFocus.reach),
    // The near roads stop at the streamed world's active tiles (by the tile's centre: a tile astride the edge is built; the far roads of the ring cover the strip twice, never a gap).
    within: (rect) => activeAt === null || activeAt((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2),
    chunks: new Map(),
    inputs: new SurfaceInputs(),
    retired: [],
    // DO NOT read the whole store at the opening: it grows with every place the camera went (CLAUDE.md, "Streaming world").
    stored: {
      has: (key) => storedKeys.has(key),
      fetch: (keys) => (tilesPrefix ? readDerivedSome<TileBundle>(tilesPrefix, keys) : Promise.resolve(new Map())),
    },
    // Kept by the road tile workers that make them (`roadTile.worker.ts`): the page only marks the key.
    workersKeep: tilesPrefix && typeof Worker !== 'undefined' ? tilesPrefix : null,
    kept: (key) => { if (tilesPrefix && !storedKeys.has(key)) noteStored(key); },
    // DO NOT hold the built tiles for idle writes (the ones made here, when the workers failed)
    keep: (key, bundle) => {
      if (!tilesPrefix || storedKeys.has(key)) return;
      // The tile's arrays handed to the writer, not copied: nothing reads them once its blocks are merged (`SurfaceReuse.keep`).
      if (tileWrites) {
        const buffers: ArrayBuffer[] = [];
        for (const tile of bundle.values()) {
          for (const a of [tile.positions, tile.normals, tile.uvs, tile.colors, tile.sections, tile.indices]) buffers.push(a.buffer as ArrayBuffer);
        }
        // DO NOT post past the ceiling: not kept, made again next time.
        if (!tileWrites.post(tilesPrefix, [[key, bundle]], buffers, buffers.reduce((n, b) => n + b.byteLength, 0))) return;
      } else writeDerivedMany(tilesPrefix, new Map([[key, bundle]]));
      noteStored(key);
    },
  };
  if (tilesPrefix && ROAD_TILES_HASH) {
    forgetOtherDerived('roadtiles', ROAD_TILES_HASH);
    void readDerivedKeys(tilesPrefix).then((kept) => {
      for (const key of kept) noteStored(key);
    }).finally(() => { storedRead = true; });
  }


  /** The world being rebuilt for the last edit (`rebuildWorld`), a slice a frame. */
  let worldJob: Generator<'wait' | void, void, void> | null = null;
  /** The roads' heights an edit solved ahead (`offerElevation`). */
  let offeredElevation: { elevation: RoadElevation; revision: number; terrain: number } | null = null;
  /** The roads' surface tiles shaped on the other cores (`roadTilePool.ts`). */
  const roadTiles = new RoadTilePool();
  /** The job was started in this frame (`pumpWorld` waits for the next). */
  let worldJobFresh = false;
  /** The next build waits for the ground under its roads (`roadStations.ts`): the world is busy as while its job runs. */
  let stationsWait = false;
  /** DO NOT hold the grading for the whole job */
  let worldJobGround = false;
  /** The opening's town (or a map opened) is held until it is whole (`revealGate.ts`). */
  const reveal = new RevealGate();
  /** Every program the game draws with, compiled before the town is shown (`shaderCatalogue.ts`). */
  /** The sets of lights the room and effect lights and the fill make, on and off: each set's programs built ahead (`shaderCatalogue.ts`). */
  const lightVariants = (): Object3D[][] => {
    const points: Object3D[] = [...roomLights, fxLights.muzzle, fxLights.blast];
    const fill = scene.getObjectByName('fill');
    const base: Object3D[] = [];
    scene.traverse((o) => { if ((o as PointLight).isLight && o.visible && o !== fill && !points.includes(o)) base.push(o); });
    // The fill is always in the scene (`environment.ts`): only the point lights switched on or off make a variant.
    return [false, true].map((lit) => [...base, ...(lit ? points : []), ...(fill ? [fill] : [])]);
  };
  const programs = createShaderCatalogue(personProgramStandIns, lightVariants);
  let openingSince: number | null = null;
  /** The opening's programs, asked of the driver all at once when the town is whole (`compileAsync`, built in parallel), and whether they are built: its unseen frame is drawn only then (`reveal` warm). */
  let openingPrograms: 'no' | 'asked' | 'built' = 'no';
  /** The streamed world's tiles round the camera (`holdOpening`): the opening shows the town once they are in. */
  let openingHeld: (() => boolean) | null = null;
  /** Builds the world of the last edit up to its next wait on a worker; it puts itself in place once complete. */
  /** DO NOT ask the next frame at once while the world's job waits on a worker: the unseen opening's frames come without the display's pace (`frameLoop.ts`), and it spun the page at 2,000 frames a second, starving the workers it waited on (2026-10-16); looked at again a display frame later. */
  const WAIT_LOOK_MS = 16;
  /** How long the unseen opening runs the world's job before letting the page take the workers' answers (`pumpWorld`). */
  const HIDDEN_RUN_MS = 50;
  let waitLook: ReturnType<typeof setTimeout> | null = null;
  const lookAgain = (): void => {
    if (waitLook !== null) return;
    waitLook = setTimeout(() => { waitLook = null; onAssetsReady(); }, WAIT_LOOK_MS);
  };
  const pumpWorld = (): void => {
    if (!worldJob) return;
    // Not in the frame of the edit itself, which has already paid for the edit and the roads' heights
    if (worldJobFresh) { worldJobFresh = false; onAssetsReady(); return; }
    // DO NOT slice it by time (amortization: the cost came back with a bigger region), and DO NOT run it whole in one frame either: one step a frame, each a product of the change (the ground's blocks, the surfaces, the details), so the page is not held for the whole job of every tile put in (it was, b4938f9: the camera stood still). What remains is the cause: those steps run on the page (CLAUDE.md, work list).
    // Behind the curtain no frame is seen: DO NOT spend a whole frame on each step there (a tile's platforms were a building a step, ~1,500 frames a tile of the opening's region, 2026-10-16): its steps run one after another until it waits on a worker, with a pause every `HIDDEN_RUN_MS` for the workers' answers to come in.
    const job = worldJob;
    const until = reveal.opened ? -Infinity : performance.now() + HIDDEN_RUN_MS;
    for (;;) {
      const step = job.next();
      if (worldJob !== job) return;
      if (step.done) { worldJob = null; shadowMoved = true; return; }
      if (step.value === 'wait') { lookAgain(); return; }
      if (performance.now() >= until) { onAssetsReady(); return; }
    }
  };
  let networkRevision = -1;
  /** The blocks the roads' heights or ground changed in since the road surfaces were last built to the end (null: not known, every tile): kept across a world build replaced halfway. */
  let surfaceBlocks: (readonly [number, number, number, number])[] | null = null;
  let terrainRevision = -1;
  /** The ground under the roads a solve will read, read off the page (`roadStations.ts`): the solve waits for it, the world standing as it was. */
  const roadStations = new RoadStations(() => onAssetsReady());
  /** The streamed world's active tiles (`setActiveTiles`): where the near roads are built; how many times they changed, and for which the world was built. */
  let activeAt: ((x: number, y: number) => boolean) | null = null;
  let activeSerial = 0;
  let activeBuilt = 0;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;
  /** The network revision the last world build that landed was of (`worldSteps`): the near roads stand for it. */
  let landedRevision = -1;
  /** The tiles put in whose near products are not all drawn yet (`tileLoaded`): the far level stands for each until they are (as Cidade's `cellLayer.ts` cellsReady: a tile draws by cells only once every cell is ready). */
  const nearPending = new Map<number, { readonly rect: ChangeRect; readonly revision: number }>();
  let onNearDrawn: ((key: number) => void) | null = null;
  const settleNearTiles = (): void => {
    if (nearPending.size === 0) return;
    // The roads drawn are the last build that landed: a tile put in at or before its revision has its near roads on screen, whatever build runs now (DO NOT wait for a frame with no job: with tiles coming one after another only a landing frame had none).
    for (const [key, p] of nearPending) {
      if (landedRevision < 0 || landedRevision < p.revision) continue;
      if (!buildings.drawnOver(p.rect, p.revision)) continue;
      nearPending.delete(key);
      onNearDrawn?.(key);
    }
  };
  let terrainMs = 0;

  const deckHeight = (
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  /** The footway's rise over the carriageway at a point (`footwayRiseAt`), kerbed before any network is built. */
  const footwayRiseHere = (x: number, y: number): number => (worldNet ? footwayRiseAt(worldNet, x, y) : FOOTWAY_RISE);
  /** See `SceneHandle.pavedHeightAt` (`world/paving.ts`). */
  const pavedHeightAt: PavingSource = Object.assign((x: number, y: number): number => {
    if (!elevation || !elevation.has(GROUND_ONLY)) return NaN;
    return pavedHeightFrom(elevation, GROUND_ONLY, footwayRiseHere, x, y);
  }, {
    pack: (rect: readonly [number, number, number, number]): { data: PavingData; transfer: ArrayBuffer[] } | null => {
      const ground = elevation !== null && elevation.has(GROUND_ONLY);
      if (ground && !elevation!.fieldFor) return null;
      const field = ground ? elevation!.fieldFor!([rect], []) : null;
      const flush = worldNet ? packFlush(worldNet, [rect]) : null;
      return { data: { rect, field: field?.data ?? null, flush: flush?.data ?? null },
        transfer: [...field?.transfer ?? [], ...flush?.transfer ?? []] };
    },
  });

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady,
    // A walker off the streets stands on what is drawn there
    (x, y) => {
      const lot = buildings.anyLotHeightAt(x, y);
      // On a road's footway or carriageway, its paving; the terrain elsewhere.
      const paved = pavedHeightAt(x, y);
      const ground = Number.isFinite(paved) ? paved : terrain.renderedHeightAt(x, y);
      return Number.isFinite(lot) ? Math.max(lot, ground) : ground;
    },
    // A resident's parked car stands on its lot as the lot is drawn.
    (building, x, y) => buildings.lotHeightAt(building as BuildingId, x, y),
    // The land alone: whether a walker off the streets is on screen at all, before the yards are asked.
    (x, y) => terrain.renderedHeightAt(x, y));

  const crowdFrustum = new Frustum();
  /** The view's frustum the buildings' detail is chosen in (`levelOfDetail`), and its matrix. */
  const detailFrustum = new Frustum();
  const detailProjection = new Matrix4();
  /** A square of the plan as `farSees` tests it. */
  const seenBox = new Box3();
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  // How tall a person stands on the screen, canvas pixels: feet and head through the view-projection (either camera)
  const pixelFoot = new Vector3(), pixelOther = new Vector3(), pixelBase = new Vector3(), cameraRight = new Vector3();
  const personPixels = (x: number, y: number, z: number, height: number): number => {
    const halfW = renderer.domElement.width * 0.5, halfH = renderer.domElement.height * 0.5;
    pixelFoot.set(x, z, -y);
    pixelOther.set(x, z + height, -y).applyMatrix4(crowdProjection);
    pixelBase.copy(pixelFoot).addScaledVector(cameraRight, height).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    const tall = Math.hypot((pixelOther.x - pixelFoot.x) * halfW, (pixelOther.y - pixelFoot.y) * halfH);
    pixelOther.copy(pixelBase);
    const across = Math.hypot((pixelOther.x - pixelFoot.x) * halfW, (pixelOther.y - pixelFoot.y) * halfH);
    return Math.max(tall, across * 0.4);
  };
  /** CSS pixels a world unit across the screen at (x, y, z) - the viewport's zoom, there */
  const screenScale = (x: number, y: number, z: number): number => {
    pixelFoot.set(x, z, -y);
    pixelOther.copy(pixelFoot).add(cameraRight).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    return Math.hypot((pixelOther.x - pixelFoot.x) * cssHalfW, (pixelOther.y - pixelFoot.y) * cssHalfH);
  };
  /** Half the canvas's CSS size, read once a frame (`draw`). */
  let cssHalfW = 1, cssHalfH = 1;
  // A vehicle is tested with its own reach, grown by its height towards the sun's side
  const vehicleBounds = new Sphere(new Vector3(), 1);
  const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    vehicleBounds.radius = radius;
    return crowdFrustum.intersectsSphere(vehicleBounds);
  };
  /** Whether such a sphere (centred as `vehicleVisible` centres it) is wholly inside the view: every plane of the frustum farther than its radius (`agents.ts` vehicleInside: a cell of parked cars standing as drawn is not walked). */
  const vehicleInside = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    for (const plane of crowdFrustum.planes) if (plane.distanceToPoint(vehicleBounds.center) < radius) return false;
    return true;
  };
  /** The ground every vehicle `vehicleVisible` passes stands on, set each frame (`frustumGroundBox`): its sphere's centre between the deepest land and the highest deck. */
  const vehicleBox: GroundBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  // A raised deck over the highest land, and room for decks stacked on it; a cut below the deepest.
  const VEHICLE_LOW = TERRAIN_MIN_HEIGHT - m(16), VEHICLE_HIGH = TERRAIN_MAX_HEIGHT + m(64) + VEHICLE_REACH * 0.3;
  // DO NOT leave the people's groups out of it: their figures are instanced meshes skinned on the GPU (`riggedCitizens.ts` citizenBones, the source SkinnedMesh never in the scene), each level a mesh, recomposed every frame for nothing.
  // The vehicles' parts and the people's meshes never move as objects (their instances do): a still tree.
  const agentParts = new Group();
  agentParts.name = 'agent-parts';
  agentParts.add(...agents.meshes);
  holdStill(agentParts);
  scene.add(agentParts);
  // The far traffic: the meso model's cars on every road outside the micro window, in one draw (`densityCars.ts`).
  const densityCars = createDensityCars(deckHeight);
  scene.add(densityCars.object);
  // What moves and casts: each sun cascade it is drawn into is drawn again while it moves (`sunCascades.ts`).
  environment.setMovers([
    { roots: agents.meshes, moving: () => simRunning && agents.casting },
    { roots: [transit.group], moving: () => simRunning && transit.moving },
    swaying,
  ]);
  for (const root of [...agents.meshes, transit.group]) moverRoots.add(root);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  // Modular buildings: their own layer, behind their own gate
  const buildings = createBuildingLayer();
  // Buildings are placed once, never moved: a still tree.
  holdStill(buildings.group);
  scene.add(buildings.group);
  // Each sun cascade draws the parts wider than its own texel only, not every part the finest one draws.
  // And every layer that registered its meshes by size (`shadowCasters.ts`): cellInstances, flags, signals, things in the hand.
  // The far cascades (1 and 2) take the buildings by their masses only (`BuildingLayer.castInto` coarse).
  environment.setCasters((texel, cascade) => {
    buildings.castInto(texel, cascade >= 1);
    castCastersInto(texel);
  });
  // The town's meshes keep their arrays only until they are on the GPU (`mesh/gpuOnly.ts`)
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    refillArrays(scene);
    for (const { mesh } of surfaceReuse.chunks?.values() ?? []) refillArrays(mesh);
    buildings.refill();
    farRoads.refill();
    nearTiles.refill();
    signs.refill();
    wantAllTexels();
  });
  /** The buildings' garden plants, and the buildings and ground they were planted for. */
  let gardens: Gardens | null = null;
  const coverKit = createGroundCoverKit();
  // The countryside's trees are hand-made models (`natureTrees.ts`), loaded once
  let natureTreeKit: NatureTreeKit | null = null;
  /** The plants and stones drawn cell by cell (`plantCells.ts`) */
  let coverCells: PlantCells | null = null;
  let natureCards: PlantCells | null = null;
  let natureForest: PlantCells | null = null;
  let paintedForest: PlantCells | null = null;
  let plantedForest: PlantCells | null = null;
  let natureTreesPending = true;
  /** Whether the camera's pull in front of a building is still moving (`isoViewport.ts` `settle`): draw again. */
  let cameraEasing = false;
  /** The town's solids as filed for the camera, for the light shut out of the streets (`canyonLight.ts`). */
  let townSolids: (() => CameraSolids) | null = null;
  /** The placements' two steps (`natureSweep`/`natureKeeps`, `coverSweep.ts`/`coverKeeps`) */
  let natureSweepState: NatureSweep | null = null;
  /** The sweep being worked towards (its key), whether plates still wait for it, and a count of the sweeps the trees were kept from. */
  let natureSweepWant = '';
  let natureSweepPending = false;
  /** The sweep the ecosystem's trees were last filed from (`fileNature`). */
  let natureFiledFrom: NatureSweep | null = null;
  /** The card trees the cover cells were last drawn for (moved: every cell drawn again), and the geology serial their stones' colours read. */
  let coverStandIns: boolean | null = null;
  let coverGeologySeen = -1;
  /** The paint the covers were swept for, read from the diary (`coverPaintRead`). */
  const coverPaintRead = new JournalCursor(['paint']);
  /** The shown plates' own ecology the ecosystem's trees were swept for (`natureSweep`): moved by a plate that came, left or changed, alone. */
  const ecologySeen = new PlateFollow((surface: { readonly ecologyRevision: number }) => surface.ecologyRevision);
  /** The trees the player planted, cell by cell as the diary says they were planted or cut (`plantedRead`). */
  const plantedRead = new JournalCursor(['trees']);
  /** What the plants' and stones' tests read, from the diary: a change there tests again only the places it reached */
  const vegetationRead = new JournalCursor(['roads', 'buildings', 'clearings', 'terrain', 'elevation', 'ground']);
  let vegetationRedraw = true;
  /** The network the keeps test against (`draw`'s). */
  let keepNet: Network | null = null;
  /** The elements laid with the brush (`elements.ts`): their models, loaded once, and the layer built for the map. */
  let elementKit: ElementKit | null = null;
  let elementLayer: ElementLayer | null = null;
  /** What the elements stand on and are, from the diary: a dab lays its own cells again, not the map's. */
  const elementRead = new JournalCursor(['elements', 'terrain', 'ground']);
  /** The elements' layer, made once their models are in: the region's cells draw in it, and a streamed world's tiles (`elementTiles.ts`). */
  const elementLayerOf = (): ElementLayer | null => {
    if (!elementKit) return null;
    if (!elementLayer) {
      elementLayer = createElementLayer(elementKit, activeTiles);
      world.add(elementLayer.group);
    }
    return elementLayer;
  };
  // The streamed world's brush elements per tile, in the elements' layer.
  nearTiles.add(elementProduct(elementLayerOf));
  void loadElementKit(anisotropy).then((kit) => { elementKit = kit; }, (error: unknown) => {
    console.warn('[elements] models not loaded', error);
  });
  /** The weather drawn (`world/weather.ts`) */
  const rain = createRain();
  const lightning = createLightning();
  const cloudDrift = { x: 0, y: 0 };
  const canvasSize = new Vector2();
  const rainWind = new Vector2();
  let weatherActive = false;
  scene.add(rain.object, lightning.group);
  const strikeListeners: ((x: number, y: number, distance: number) => void)[] = [];
  /** A bolt onto the map point (x, y), from some way up in the sky. */
  const strikeAt = (x: number, y: number): void => {
    const ground = terrain.renderedHeightAt(x, y);
    const up = m(260) + Math.random() * m(140);
    lightning.strike(new Vector3(x + (Math.random() - 0.5) * up * 0.3, ground + up, -y + (Math.random() - 0.5) * up * 0.3), new Vector3(x, ground, -y));
    const distance = Math.hypot(x - rig.target.x, y + rig.target.z);
    for (const listener of strikeListeners) listener(x, y, distance);
  };
  /** The gully revision the relief was baked for. */
  let gulliesFor = -1;
  /** The painted fog's map (`fogLayer.ts`), and the fog and land it was built for. */
  const fogTexture = createFogTexture();
  let fogLayer: FogLayer | null = null;
  const fogField = createFogField(fogTexture);
  /** What the fog map follows in the diary, and how far it was read. */
  const FOG_KINDS: readonly ChangeKind[] = ['fog', 'terrain', 'ground'];
  let fogJournal: ChangeJournal | null = null;
  let fogSeen = -1;
  let fogTerrainSeen = -1;
  let fogMoving = false;
  /** Clouds placed on the map: they boil, so the frame is drawn now and then. */
  let placedCloudsShown = false;
  let natureTreesStarted = false;
  /** @rebuild Once, when the first world is in (`draw`). */
  const startNatureTrees = (): void => {
    natureTreesStarted = true;
    void loadNatureTrees(anisotropy).then(async (kit) => {
      // Its programs built before the first forest is drawn - its shadow's too, wind-swayed (`uploads.ts` shadowStandIn)
      const sample = buildNatureForest(FOREST_SPECIES.flatMap((species) => [0.1, 0.35, 0.6, 0.85].map((seed) => ({ x: 0, y: 0, z: 0, size: m(12), yaw: 0, seed, species }))), kit);
      const lit = new Group(), shadows = new Group();
      for (const mesh of sample.meshes) {
        lit.add(mesh);
        const standIn = shadowStandIn(mesh);
        if (standIn) shadows.add(standIn);
      }
      await Promise.all([compileAhead(lit), compileAhead(shadows, true)]);
      lit.clear();
      shadows.clear();
      sample.dispose();
      natureTreeKit = kit;
      // The kept trees are grown with it at the next look.
      vegetationRedraw = true;
      onAssetsReady();
    }, (error: unknown) => {
      natureTreesPending = false;
      vegetationRedraw = true;
      console.warn('[nature] trees not loaded; the procedural ones stay', error);
      onAssetsReady();
    });
  };
  /** The buildings cut open, for the people drawn inside them (`indoors.ts`). */
  let cutSpec: CutawaySpec | null = null;
  let skyMode: SkyMode = 'day';
  /** Clouds and mist as the player set them (`setAtmosphere`). */
  let atmosphere: Atmosphere = DEFAULT_ATMOSPHERE;
  /** The sun's colour times its strength, that the clouds are lit by. */
  const sunLight = new Color();
  /** Towards the sun, for the relief's own shadows (`TerrainSurface.setSun`). */
  const sunTowards = new Vector3();
  const flatDirection = new Vector3();
  const roomLamps = new RoomLamps();
  // Room lights for the floors cut open: a fixed set, so switching them on and off never changes the scene's light count
  const roomLights: PointLight[] = [];
  for (let i = 0; i < ROOM_LIGHTS; i++) {
    const light = new PointLight(0xffd6a0, 0, m(8), 2);
    light.name = 'room-light';
    light.castShadow = false;
    scene.add(light);
    roomLights.push(light);
  }
  let lampsKey = '';
  let lastDark = -1;
  /** The building revision the ground was last graded for. */
  let gradedFor = -1;
  /** What the ground under the buildings is graded from (`buildingPads`) */
  /** The ground the buildings were last graded on (frozen while a stroke is held). */
  let buildingGround = '';
  /** Where and when the drawn ground changed: what stands on it is set again only there (`groundChanges.ts`). */
  let groundDiary: ChangeJournal | null = null;
  const GROUND_KINDS: readonly DerivedChangeKind[] = ['elevation', 'ground'];
  /** The serial of the latest change of the ground (not of the diary: a zone drawn is no change of the ground), and how far the diary was read for it. */
  let groundVersion = 0, groundScanned = 0;
  /** Where the ground changed after `since`, from the diary; null where it cannot say (the whole map, or forgotten). */
  const groundRectsSince = (since: number): ChangeRect[] | null => {
    const entries = groundDiary?.since(since, GROUND_KINDS);
    if (!entries) return null;
    const rects: ChangeRect[] = [];
    for (const entry of entries) {
      if (entry.rects === null) return null;
      rects.push(...entry.rects);
    }
    return rects;
  };
  const groundChanges: GroundRecord = {
    get version() {
      const diary = groundDiary;
      if (!diary || diary.version === groundScanned) return groundVersion;
      const fresh = diary.since(groundScanned, GROUND_KINDS);
      if (fresh === null) groundVersion = diary.version;
      else if (fresh.length) groundVersion = fresh[fresh.length - 1]!.serial;
      groundScanned = diary.version;
      return groundVersion;
    },
    touches: (since, area) => groundDiary?.touches(since, area, GROUND_KINDS) ?? false,
    // DO NOT leave it out: without it the gardens asked every planted building of the city whether the ground moved under it
    rectsSince: (since) => groundRectsSince(since),
  };
  /** The gardens' plants, building by building, on the ground they stand on (`gardenLists.ts`). */
  const plantLists = gardenLists(groundChanges, (b) => bankBox(b), (b) => gardenPlants([b], terrain.renderedHeightAt), activeTiles);
  // The streamed world's gardens per tile (`gardenTiles.ts`), in the gardens' own cells: the region places none.
  nearTiles.add(gardenProduct(() => (gardens ??= createGardens(sceneryKit)), world));
  // The near products' bakes read the ground shared with the workers and the clearings; a tile the ground changed under (a stroke of the relief too) or a clearing cut in is asked again, its bake kept where what it reads did not change (`nearTileBake.ts` groundDigest, readKey).
  const NEAR_GROUND_KINDS: readonly ChangeKind[] = ['elevation', 'ground', 'terrain', 'clearings'];
  nearTiles.setGround(() => ({ ground: farRoadGround(), naturalIsGround: buildings.farEnv().naturalIsGround }), {
    get version() { return groundDiary?.version ?? 0; },
    touches: (since, area) => groundDiary?.touches(since, area, NEAR_GROUND_KINDS) ?? false,
    rectsSince: (since) => {
      const entries = groundDiary?.since(since, NEAR_GROUND_KINDS);
      if (!entries) return null;
      const rects: ChangeRect[] = [];
      for (const entry of entries) { if (entry.rects === null) return null; rects.push(...entry.rects); }
      return rects;
    },
  });
  /** Where the ground changed since a serial, from the same diary (`cameraSolids.ts` `GroundSince`). */
  const groundSince: GroundSince = {
    get version() { return groundChanges.version; },
    rectsSince: (since) => groundRectsSince(since),
  };
  /** What a building's floor reads (`floors.ts` on `builtGroundAt` and `pavedHeightAt`): the natural ground and the roads' heights, never the ground cut and filled to them
   *  - DO NOT re-floor the buildings for the diary's 'ground' (the ground shaped to the roads and the sites): it is not what the floor reads, and every block shaped in an opening re-floored the buildings round it again (3.7 floors a building, 2026-10-16). */
  const FLOOR_KINDS: readonly ChangeKind[] = ['elevation', 'terrain'];
  const floorGroundSince: GroundSince = {
    get version() { return groundDiary?.serialOf(...FLOOR_KINDS) ?? 0; },
    rectsSince: (since) => {
      const entries = groundDiary?.since(since, FLOOR_KINDS);
      if (!entries) return null;
      const rects: ChangeRect[] = [];
      for (const entry of entries) {
        if (entry.rects === null) return null;
        rects.push(...entry.rects);
      }
      return rects;
    },
  };
  /** Where a building's floor reads the ground and the paving (`FLOOR_READ_REACH`), once per record. */
  const floorBoxes = new WeakMap<Building, ChangeRect>();
  const floorBox = (b: Building): ChangeRect => {
    let box = floorBoxes.get(b);
    if (!box) {
      const r = storedBounds(b, FLOOR_READ_REACH);
      floorBoxes.set(b, box = [r.minX, r.minY, r.maxX, r.maxY]);
    }
    return box;
  };
  /** The buildings' solids for the camera's eye (`world/buildings/cameraSolids.ts`) */
  /** DO NOT key the canyon on a revision of the whole town again: it laid its whole window at every building. */
  const CANYON_KINDS: readonly ChangeKind[] = ['buildings', 'ground', 'elevation'];
  const CANYON_GROUND_REACH = FLOOR_READ_REACH + m(64);
  let canyonJournal: ChangeJournal | null = null;
  let canyonSerial = -1;
  const NOTHING_CHANGED: readonly ChangeRect[] = [];
  const canyonChanges = (journal: ChangeJournal): readonly ChangeRect[] | null => {
    const serial = journal.serialOf(...CANYON_KINDS);
    if (journal === canyonJournal && serial === canyonSerial) return NOTHING_CHANGED;
    const entries = journal === canyonJournal && canyonSerial >= 0 ? journal.since(canyonSerial, CANYON_KINDS) : null;
    canyonJournal = journal;
    canyonSerial = serial;
    if (!entries || entries.some((e) => e.rects === null)) return null;
    // The ground moved under a building's floor (it reads the ground round it) lifts the whole building
    const grow = (r: ChangeRect, d: number): ChangeRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
    return entries.flatMap((e) => e.kind === 'buildings' ? e.rects! : e.rects!.map((r) => grow(r, CANYON_GROUND_REACH)));
  };
  /** Each building's floor, once per record while what it reads stands (`floors.ts`) */
  const floors = buildingFloors(builtGroundAt, pavedHeightAt, floorBox, FLOOR_READ_REACH);
  /** `shaped`: the regions the caller is shaping, where the diary cannot say what moved (`floors.ts` `follow`). */
  const followFloors = (net: Network, shaped: readonly ChangeRect[] | null = null): void => floors.follow(net.doc.buildings, floorGroundSince, shaped);
  const cameraSolidsKept = cameraSolidsKeeper((b) => floors.floorOf(b), floorBox, FLOOR_READ_REACH);
  /** The roads watched for vanishing from the picture */
  let roadsWatchedAt = 0;
  let roadsReported = false;
  /** DO NOT copy every ribbon to pick four: a walk over the live map, four ribbons a look, started again at its end. */
  let roadsWalk: { readonly net: Network; readonly at: Iterator<SegmentRibbon> } | null = null;
  const nextWatched = (net: Network): SegmentRibbon | null => {
    let walk = roadsWalk;
    if (!walk || walk.net !== net) roadsWalk = walk = { net, at: net.ribbons.values() };
    let step = walk.at.next();
    if (step.done) { roadsWalk = walk = { net, at: net.ribbons.values() }; step = walk.at.next(); }
    return step.done ? null : step.value;
  };
  const watchRoads = (net: Network): void => {
    const now = performance.now();
    // Not while the world is being rebuilt: until the job lands the new roads have no picture yet by design
    if (now - roadsWatchedAt < 1000 || !reveal.opened || net.doc.segments.size === 0 || worldJob !== null) return;
    roadsWatchedAt = now;
    // DO NOT count every road mesh's vertices: one drawn mesh is the answer.
    const vertices = roads ? firstDrawnVertices(roads.group) : 0;
    let buried: { x: number; y: number; land: number; paved: number } | null = null;
    for (let k = 0; k < 4; k++) {
      const ribbon = nextWatched(net);
      if (!ribbon) break;
      const p = ribbon.full.sampleAt(ribbon.full.length / 2).p;
      const paved = pavedHeightAt(p.x, p.y), land = terrain.renderedHeightAt(p.x, p.y);
      // Under the land on purpose in a tunnel.
      if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
      if (Number.isFinite(paved) && land > paved + m(0.3)) { buried = { x: p.x, y: p.y, land, paved }; break; }
    }
    // The streamed world's roads are the tiles' (`farRoads.ts`): the region draws none by design.
    const missing = activeAt === null && (!roads || !roads.group.parent || vertices === 0);
    if ((missing || buried) && !roadsReported) {
      roadsReported = true;
      // Once, latched by `roadsReported`; as text, so a headless console log keeps it.
      console.error('roads missing from the picture', JSON.stringify({
        missing, buried, vertices, inWorld: !!roads?.group.parent, worldJob: worldJob !== null,
        terrainRevision: net.doc.terrainRevision, revision: net.revision,
      }));
    } else if (!missing && !buried) roadsReported = false;
  };
  /** Cuts and fills the ground to the roads AND to the buildings */
  /** Each building's platform, the town's, and the sites as last graded (`world/buildings/siteGrading.ts`). */
  /** The level ground round a platform before its bank, the page's and the ground worker's (`padsAskOf`). */
  const SITE_APRON = TERRAIN_CELL * 1.5;
  const sitesGraded = siteGrading(builtGroundAt, pavedHeightAt, SITE_APRON, (b) => bankBox(b), floors);
  /** The box a building's bank reaches, once per record (records are never changed in place) */
  const bankBoxes = new WeakMap<Building, readonly [number, number, number, number]>();
  /** How far a building's bank reaches past its own bounds. */
  const BANK_REACH = TERRAIN_CELL * 1.5 + m(40) + TERRAIN_CELL;
  const bankBox = (b: Building): readonly [number, number, number, number] => {
    let box = bankBoxes.get(b);
    if (!box) {
      const r = storedBounds(b, BANK_REACH);
      bankBoxes.set(b, box = [r.minX, r.minY, r.maxX, r.maxY]);
    }
    return box;
  };
  /** DO NOT walk the town for it: every building's bank was made again at each building grown */
  const buildingsOnGroundSince = (doc: RoadDoc, serial: number): Building[] | null => {
    const rects = groundSince.rectsSince(serial);
    if (!rects) return null;
    // Every change in one look (`nearAny`): a change at a time read the cells they share again for each.
    return doc.buildings.nearAny(rects, BANK_REACH, (b, r) => {
      const box = bankBox(b);
      return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
    });
  };
  /** The ground serial the buildings were last told of (`buildingGround`). */
  let buildingGroundSeen = -1;
  /** Where two solves of the roads differ: the blocks of the map whose ground the roads shape differently. */
  const SHAPE_BLOCK = 160;
  /** The ground's blocks a side of the square a step of the platforms covers (`shapeBlocksSteps`). */
  const PADS_SQUARE = 4;
  /** What a block of ground reads of a solve, digested: at each corner of the terrain grid in it */
  const groundRead = new WeakMap<RoadElevation, Map<number, number>>();
  /** The blocks of a solve being digested off the page, each with the job that will file it (`compareSolves`). */
  const groundReading = new WeakMap<RoadElevation, Map<number, Promise<void>>>();
  const blockKey = (x0: number, y0: number): number => x0 * 65_536 + y0;
  const readOf = (solve: RoadElevation): Map<number, number> => {
    let known = groundRead.get(solve);
    if (!known) groundRead.set(solve, known = new Map());
    return known;
  };
  /** A block of a solve digested on the page (`groundShape.ts` `blockDigest`, the worker's own function). */
  const blockRead = (solve: RoadElevation, x0: number, y0: number): number => {
    const known = readOf(solve);
    const key = blockKey(x0, y0);
    const kept = known.get(key);
    if (kept !== undefined) return kept;
    const value = blockDigest(solve, terrain.naturalRenderedHeightAt, x0, y0, SHAPE_BLOCK, TERRAIN_CELL, TERRAIN_HALF);
    known.set(key, value);
    return value;
  };
  /** The plates whose blocks a comparison reads: those the boxes reach, or (no boxes) the plates drawn in full. */
  const platesUnder = (where: readonly { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }[] | null):
    { readonly cx: number; readonly cy: number; readonly half: number }[] => {
    if (!where) return terrain.parts.map((p) => ({ cx: p.cx, cy: p.cy, half: TERRAIN_HALF }));
    const keys = new Set<number>();
    for (const r of where) for (const k of platesOver([r.minX, r.minY, r.maxX, r.maxY])) keys.add(k);
    return [...keys].map(plateRegion);
  };
  /** Two solves compared block by block (`compareSolves`): `blocks` once `ready`, with the page's time it took. */
  interface BlockCompare { blocks: [number, number, number, number][]; ready: boolean; ms: number }
  /** The blocks whose ground two solves of the roads shape differently, or whose decks differ */
  const compareSolves = (before: RoadElevation, after: RoadElevation, landBlocks: readonly [number, number, number, number][] | null): BlockCompare => {
    const at = performance.now();
    const out: BlockCompare = { blocks: [], ready: false, ms: 0 };
    const candidates: [number, number][] = [];
    // Only blocks a road that differs reaches can differ (`differences`)
    const where = after.differences?.(before) ?? null;
    if (!where || where.length) {
      // The blocks of the plates the differences reach; not knowing where, of the plates drawn in full (only their ground is shaped, `shapeToRoads`), never of a world's plates.
      for (const plate of platesUnder(where)) {
        for (let x = plate.cx - plate.half; x < plate.cx + plate.half; x += SHAPE_BLOCK) {
          for (let y = plate.cy - plate.half; y < plate.cy + plate.half; y += SHAPE_BLOCK) {
            const x1 = x + SHAPE_BLOCK, y1 = y + SHAPE_BLOCK;
            if (where && !where.some((r) => r.minX <= x1 && r.maxX >= x && r.minY <= y1 && r.maxY >= y)) continue;
            candidates.push([x, y]);
          }
        }
      }
    }
    const finish = (): void => {
      const changed: [number, number, number, number][] = [];
      for (const [x, y] of candidates) if (blockRead(before, x, y) !== blockRead(after, x, y)) changed.push([x, y, x + SHAPE_BLOCK, y + SHAPE_BLOCK]);
      if (landBlocks) {
        const seen = new Set(changed.map((b) => `${b[0]},${b[1]}`));
        for (const b of landBlocks) if (!seen.has(`${b[0]},${b[1]}`)) changed.push(b);
      }
      out.blocks = changed;
      out.ready = true;
    };
    const waits: Promise<void>[] = [];
    const ask: { solve: RoadElevation; blocks: [number, number][] }[] = [];
    for (const solve of [before, after]) {
      const known = readOf(solve);
      const reading = groundReading.get(solve);
      const mine: [number, number][] = [];
      for (const [x, y] of candidates) {
        const key = blockKey(x, y);
        if (known.has(key)) continue;
        const job = reading?.get(key);
        if (job) { if (!waits.includes(job)) waits.push(job); continue; }
        mine.push([x, y]);
      }
      if (mine.length) ask.push({ solve, blocks: mine });
    }
    if (ask.length && groundWorkers.available && ask.every((a) => a.solve.shapeCut)) {
      // The roads near the blocks asked and the ground under them, as plain numbers; a block the worker cannot read
      const rect = (x: number, y: number): [number, number, number, number] => [x - 1, y - 1, x + SHAPE_BLOCK + 1, y + SHAPE_BLOCK + 1];
      const job: BlockDigestAsk = {
        solves: ask.map(({ solve, blocks }) => ({
          roads: solve.shapeCut!(blocks.map(([x, y]) => rect(x, y))),
          blocks: Float64Array.from(blocks.flat()),
        })),
        plates: terrain.naturalCut?.(ask.flatMap(({ blocks }) => blocks.map(([x, y]) => rect(x, y)))) ?? [],
        block: SHAPE_BLOCK, cell: TERRAIN_CELL, half: TERRAIN_HALF,
      };
      const filed = groundWorkers.digest(job).then((answers) => {
        ask.forEach(({ solve, blocks }, k) => {
          const known = readOf(solve);
          blocks.forEach(([x, y], j) => { const v = answers[k]![j]!; if (!Number.isNaN(v)) known.set(blockKey(x, y), v); });
        });
      }, (error: unknown) => { console.warn('[ground] blocks digested on the page', error); }).finally(() => {
        for (const { solve, blocks } of ask) for (const [x, y] of blocks) groundReading.get(solve)?.delete(blockKey(x, y));
      });
      for (const { solve, blocks } of ask) {
        let reading = groundReading.get(solve);
        if (!reading) groundReading.set(solve, reading = new Map());
        for (const [x, y] of blocks) reading.set(blockKey(x, y), filed);
      }
      waits.push(filed);
    }
    if (!waits.length) { finish(); out.ms = performance.now() - at; return out; }
    out.ms = performance.now() - at;
    void Promise.all(waits).then(() => { const t = performance.now(); finish(); out.ms += performance.now() - t; });
    return out;
  };
  /** A terrain region (`terrainRegion`) back as the world box it covers, a cell round. */
  const regionRect = (region: TerrainRegion): Rect => terrain.rectOf(region);
  /** A world box as the terrain grid corners it covers. */
  const terrainRegion = (box: readonly [number, number, number, number]): TerrainRegion => terrain.regionOf(box);
  /** `region`: a brush dab while the stroke is held */
  /** The ground cut and filled again only in `blocks` (the roads changed there, the land did not) */
  /** `shapeBlocks` in steps (`worldSteps`) */
  /** The platforms of these buildings asked of the ground's worker: their records, their floors as kept, the paving over their banks and the shared ground; null where it cannot be handed over. */
  const padsAskOf = (list: readonly Building[]): PadsAsk | null => {
    const ground = (terrain.renderedHeightAt as SharedGroundAt).share?.current;
    if (!ground || !pavedHeightAt.pack) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of list) {
      const box = bankBox(b);
      x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]); x1 = Math.max(x1, box[2]); y1 = Math.max(y1, box[3]);
    }
    const paving = pavedHeightAt.pack([x0, y0, x1, y1]);
    if (!paving) return null;
    return { buildings: list.map((b) => ({ record: refOf(b), floor: floors.floorOf(b) })), paving: paving.data, ground, apron: SITE_APRON };
  };
  function* shapeBlocksSteps(net: Network, blocks: readonly [number, number, number, number][]): Generator<'wait' | void, void, void> {
    // DO NOT walk `buildings.all()` for them, nor every building for a platform not known yet (`ensure`, a building a step)
    const reached = net.doc.buildings.nearAny(blocks, BANK_REACH, (b, q) => {
      const box = bankBox(b);
      return box[0] <= q[2] && box[2] >= q[0] && box[1] <= q[3] && box[3] >= q[1];
    });
    followFloors(net, blocks);
    // The platforms worked out by the ground's worker, in one ask for the change (`groundShape.ts` `padsOfAsk`): DO NOT work them out on the page a square a frame - ~0.2 s of the page a tile, the tile's near roads waiting behind them.
    const padsAsk = reached.length ? padsAskOf(reached) : null;
    let padsTaken = false;
    if (padsAsk && groundWorkers.available) {
      let answer: (Pad | null)[] | null = null, failed = false;
      groundWorkers.pads(padsAsk).then((pads) => { answer = pads; }, (error: unknown) => {
        console.warn('[ground] the platforms are worked out on the page', error);
        failed = true;
      });
      while (!answer && !failed) { groundWorkers.check(); yield 'wait'; }
      const pads = answer as (Pad | null)[] | null;
      if (pads) { reached.forEach((b, i) => sitesGraded.take(b, pads[i] ?? null)); padsTaken = true; }
    }
    if (!padsTaken) {
      // No worker (or it could not): a step a square of the ground's blocks (`PADS_SQUARE` of them a side), never a building a step.
      const side = SHAPE_BLOCK * PADS_SQUARE;
      const bySquare = new Map<string, Building[]>();
      for (const b of reached) {
        const box = bankBox(b);
        const k = `${Math.floor((box[0] + box[2]) / 2 / side)},${Math.floor((box[1] + box[3]) / 2 / side)}`;
        let list = bySquare.get(k);
        if (!list) bySquare.set(k, list = []);
        list.push(b);
      }
      for (const list of bySquare.values()) {
        for (const b of list) sitesGraded.refresh(b);
        yield;
      }
    }
    gradedFor = net.doc.buildings.revision;
    // The sites that changed with the edit
    const sites = sitesGraded.changedSites(net.doc.buildings);
    sitesGraded.rebuild(net.doc.buildings);
    yield;
    // Each block in quarters, a quarter a step: a whole block was 18 ms of terrain in one step, past the frame's allowance
    const quarters = (q: readonly [number, number, number, number]): [number, number, number, number][] => {
      const mx = (q[0] + q[2]) / 2, my = (q[1] + q[3]) / 2;
      return [[q[0], q[1], mx, my], [mx, q[1], q[2], my], [q[0], my, mx, q[3]], [mx, my, q[2], q[3]]];
    };
    const regions = blocks.flatMap(quarters).map(terrainRegion);
    if (sites) regions.push(...sites.map(terrainRegion));
    // DO NOT cut it into a block a step again: that spread the page's work over frames, and it is the worker's now.
    const shaping = shapeGround(net, regions, false, true);
    while (!shaping.landed) { landShapes(); if (shaping.landed) break; yield 'wait'; }
    derived(net, 'ground', regions.map(regionRect), 'ground cut and filled up to the roads', worldCause,
      { ms: shaping.ms, detail: `${regions.length} regions` });
  }


  /** The ground's work off the page (`groundShapePool.ts`). */
  const groundWorkers = new GroundShapePool();
  /** A shaping pass asked of the ground's worker (`shapeGround`): put in place in the order asked (`landShapes`). */
  interface Shaping {
    readonly ask: GroundShapeAsk;
    readonly take: (answers: readonly PlateShapeAnswer[]) => boolean;
    /** What the ground's readers are told, once the heights are in place (the diary's 'ground'). */
    readonly then: () => void;
    answers: PlateShapeAnswer[] | null;
    failed: boolean;
    landed: boolean;
    /** The page's time: the ask put together and the answer put in place. */
    ms: number;
  }
  /** The passes asked, in order. */
  const shapings: Shaping[] = [];
  const LANDED = { landed: true, ms: 0 } as const;
  /** Puts in place every pass answered, in the order asked, up to the first still being worked out. */
  const landShapes = (): void => {
    while (shapings.length) {
      const next = shapings[0]!;
      if (!next.answers && !next.failed) { groundWorkers.check(); return; }
      shapings.shift();
      const at = performance.now();
      next.take(next.answers ?? shapeGroundAsk(next.ask));
      next.ms += performance.now() - at;
      next.landed = true;
      next.then();
    }
  };
  /** DO NOT shape the corners here while the worker is there: 9.5 s of the page in a 2,560 m city's growth (2026-10-15). */
  const shapeGround = (net: Network, regions: TerrainRegion | readonly TerrainRegion[] | null = null, sites = false, padsReady = false): { readonly landed: boolean; readonly ms: number } => {
    const at = performance.now();
    const list: readonly TerrainRegion[] | null = regions === null ? null
      : typeof regions[0] === 'number' ? [regions as TerrainRegion] : regions as readonly TerrainRegion[];
    if (list && !list.length) return LANDED;
    const region = list;
    // The ground is cut and filled here, and only here: what stands on it reads where from the diary
    const parent = net.doc.changes.version;
    const told = (): void => {
      if (padsReady) return;
      derived(net, 'ground', list ? list.map(regionRect) : null, sites ? 'lot ground levelled' : 'ground cut and filled', parent);
    };
    const roads = net.doc.segments.size > 0 ? elevation : null;
    followFloors(net, list ? list.map(regionRect) : null);
    if (!padsReady && (!region || !sitesGraded.pads || sites)) {
      gradedFor = net.doc.buildings.revision;
      // The roads or the land moved: the platforms whose banks the diary says they moved under worked out afresh (`siteGrading.ts` `follow`, the floors' own changes); every one only the first time, or where the diary cannot say.
      if (!sites) {
        if (sitesGraded.pads) sitesGraded.follow(net.doc.buildings, floorGroundSince, BANK_REACH);
        else sitesGraded.forget(net.doc.buildings);
      }
      sitesGraded.rebuild(net.doc.buildings);
    }
    const pads = net.doc.buildings.size > 0 ? sitesGraded.pads : null;
    if (groundWorkers.available || shapings.length) {
      // The corners asked, and the roads and platforms they read as they stand now, as plain numbers.
      const asking = terrain.askShape(region, region ? null : [...(roads?.shapeBounds() ?? []), ...(pads?.shapeBounds() ?? [])]);
      const boxes = cornerBoxes(asking.plates, TERRAIN_CELL, TERRAIN_HALF);
      const ask: GroundShapeAsk = { roads: roads ? roads.shapeCut!(boxes) : null, pads: pads ? pads.cut(boxes) : null, plates: asking.plates };
      const shaping: Shaping = { ask, take: asking.take, then: told, answers: null, failed: false, landed: false, ms: 0 };
      shapings.push(shaping);
      if (groundWorkers.available) {
        groundWorkers.shape(ask).then((answers) => { shaping.answers = answers; }, (error: unknown) => {
          console.warn('[ground] a pass is shaped on the page', error);
          shaping.failed = true;
        });
      } else shaping.failed = true;
      shaping.ms = performance.now() - at;
      // No worker: put in place now, after the passes before it.
      if (shaping.failed) landShapes();
      return shaping;
    }
    told();
    const shape = pads ? { shapeBounds: () => [...(roads?.shapeBounds() ?? []), ...pads.shapeBounds()], shapeAt: shapeBoth(roads, pads) } : roads;
    terrain.shapeToRoads(shape, region);
    return { landed: true, ms: performance.now() - at };
  };

  /** `doc.utilityRevision` the poles and the furniture were last brought up to. */
  let utilityRevision = -1;
  /** What moves a pole or its parts: the poles and wires, the roads (its kerb), the roads' heights and the ground under it. */
  const POLE_KINDS: readonly ChangeKind[] = ['utilities', 'roads', 'elevation', 'ground', 'terrain'];
  /** The diary's serial of `POLE_KINDS` the pole layer was brought up to. */
  let poleSerial = -1;
  /** Where the active tiles moved since the poles were last brought up: their poles placed or let go (`activeTiles.ts`). */
  const poleMoves = activeTiles.reader();
  /** The pole layer brought up to the diary (`poleLayer.ts`) */
  const syncUtilities = (net: Network, groundAt: (x: number, y: number) => number): void => {
    const serial = net.doc.changes.serialOf(...POLE_KINDS);
    // THE STREAMED WORLD'S POLES ARE THE TILES' (`poleTiles.ts`, each tile baked in a worker, an edited one from the page's records): the region places none. Its layer took in and let go three tiles of poles on the page at every tile's edge the camera crossed (plan 2.4.1).
    if (activeAt !== null) {
      if (utilities) { builtTriangles -= utilities.triangles; world.remove(utilities.group); utilities.dispose(); utilities = null; }
      poleMoves.take();
      poleSerial = serial;
      return;
    }
    if (utilities && serial === poleSerial && !poleMoves.pending) return;
    const entries = utilities ? net.doc.changes.since(poleSerial, POLE_KINDS) : null;
    const moved = poleMoves.entries('utilities');
    const before = utilities?.triangles ?? 0;
    if (!utilities || entries === null || moved === null || entries.some((e) => e.rects === null)) {
      if (utilities) { world.remove(utilities.group); utilities.dispose(); }
      utilities = buildUtilities(net, groundAt, sceneryKit, docPoles(net.doc, activeTiles));
      world.add(utilities.group);
    } else {
      utilities.follow(net, groundAt, net.doc, [...entries, ...moved], docPoles(net.doc, activeTiles));
    }
    builtTriangles += utilities.triangles - before;
    poleSerial = serial;
  };
  /** The poles and the placed things, outside a world being built: a pole edit moves only `doc.utilityRevision` */
  const rebuildUtilities = (net: Network): void => {
    if (!elevation) return;
    utilityRevision = net.doc.utilityRevision;
    const at = performance.now();
    syncUtilities(net, poleGroundAt(elevation, terrain.renderedHeightAt, net));
    measureHitch('hitch:utilities/poles', at);
  };

  /** The city's clock, read each frame: the planted trees and shrubs grow with it (`plantGrowth`). */
  let cityMinutes = Number.NaN;
  /** The street furniture and the signs brought up to the diary, once the world stands (`draw`): the furniture item by item */
  /** The world the placed things stand on, once it stands (`draw`): what the engine's 'draw' phase reads. */
  let placedOn: Network | null = null;
  engine.register({
    name: 'street furniture',
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      const at = performance.now();
      const before = furniture.triangles;
      const work = furniture.sync(placedOn, elevation, terrain.renderedHeightAt, cityMinutes);
      builtTriangles += furniture.triangles - before;
      measureHitch('hitch:furniture', at);
      return work;
    },
  }, 'draw');
  engine.register({
    name: 'signs',
    // DO NOT build every sign of the map again on a serial of the roads, the land or the landscaping: every edit anywhere did.
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      if (!signs.group.parent) world.add(signs.group);
      return signs.sync(placedOn, elevation);
    },
  }, 'draw');

  engine.register({
    name: 'barriers',
    // DO NOT build every barrier of the map again on its revision or on a change of the ground under any one.
    refresh: (): number => {
      if (!placedOn) return 0;
      if (!barriers.group.parent) world.add(barriers.group);
      const before = barriers.triangles;
      const work = barriers.sync(placedOn.doc, terrain.renderedHeightAt);
      builtTriangles += barriers.triangles - before;
      return work;
    },
  }, 'draw');
  engine.register({
    name: 'transit',
    // DO NOT build the whole transport again on its revision or the ground under it.
    refresh: (): number => {
      const net = placedOn;
      if (!net) return 0;
      if (!transit.group.parent) { world.add(transit.group); transit.setXray(transitXray); }
      const before = transit.triangles;
      // A metro entrance stands off the streets and out of the buildings: the buildings at the point only
      const work = transit.sync(net.doc, terrain.renderedHeightAt, pavedHeightAt, (p) => {
        if (onCarriageway(net, p)) return true;
        for (const b of net.doc.buildings.near(p.x, p.y, p.x, p.y)) {
          if (solidFootprints(b).some((ring) => pointInPolygon(p, ring))) return true;
        }
        return false;
      });
      builtTriangles += transit.triangles - before;
      return work;
    },
  }, 'draw');

  /** The comparisons of solves whose blocks a dropped rebuild had not shaped yet */
  let pendingBlocks: (BlockCompare | null)[] = [];
  /** The land a brush moved since the world was last built */
  let landDirty: Rect | 'all' | null = null;
  /** The diary's land entries, read every frame: where a rewrite the terrain cannot place (an undo, a stamp dropped) moved the land. */
  const landRead = new JournalCursor(['terrain']);
  /** Where the land entries since the last frame moved it, grown by a terrain cell each side (a stamp's rewrite reaches a cell past its circle, `terrain.ts`); null when one cannot say. */
  const landMovedSince = (entries: readonly Change[] | null): Rect | null => {
    if (entries === null || entries.length === 0) return null;
    let box: Rect | null = null;
    for (const e of entries) {
      if (e.rects === null) return null;
      for (const r of e.rects) box = unionRect(box, [r[0] - 2 * TERRAIN_CELL, r[1] - 2 * TERRAIN_CELL, r[2] + 2 * TERRAIN_CELL, r[3] + 2 * TERRAIN_CELL]);
    }
    return box;
  };
  /** The shaping blocks a world box reaches, on the grid `changedBlocks` uses. */
  const blocksOver = (box: Rect): [number, number, number, number][] => {
    const out: [number, number, number, number][] = [];
    for (const key of platesOver(box)) {
      const plate = plateRegion(key);
      const left = plate.cx - plate.half, right = plate.cx + plate.half;
      const bottom = plate.cy - plate.half, top = plate.cy + plate.half;
      if (box[2] <= left || box[0] >= right || box[3] <= bottom || box[1] >= top) continue;
      const x0 = Math.max(left, Math.floor((box[0] - left) / SHAPE_BLOCK) * SHAPE_BLOCK + left);
      const y0 = Math.max(bottom, Math.floor((box[1] - bottom) / SHAPE_BLOCK) * SHAPE_BLOCK + bottom);
      for (let x = x0; x < Math.min(right, box[2]); x += SHAPE_BLOCK) {
        for (let y = y0; y < Math.min(top, box[3]); y += SHAPE_BLOCK) out.push([x, y, x + SHAPE_BLOCK, y + SHAPE_BLOCK]);
      }
    }
    return out;
  };
  /** The diary entry the world being built follows from (`world/changes.ts`). */
  let worldCause = 0;
  /** Writes what the world derived in the document's diary, after `parent`; its serial (0: nothing written). */
  const derived = (net: Network, kind: DerivedChangeKind, rects: readonly ChangeRect[] | null, cause: string, parent: number,
    extra: { readonly ms?: number; readonly detail?: string } = {}): number =>
    net.doc.changes.record(kind, rects, { cause, ...(parent ? { parent } : {}), ...extra });
  /** The network the world was last built for: what stands on a footway reads it (`footwayRiseAt`). */
  let worldNet: Network | null = null;
  const rebuildWorld = (net: Network): void => {
    worldNet = net;
    if (networkRevision === net.revision && terrainRevision === net.doc.terrainRevision && activeBuilt === activeSerial) {
      stationsWait = false;
      // A world being built builds the poles too (`worldSteps`)
      if (worldJob === null && (utilityRevision !== net.doc.utilityRevision || poleSerial !== net.doc.changes.serialOf(...POLE_KINDS))) {
        const atUtilities = performance.now();
        rebuildUtilities(net);
        measureHitch('hitch:road-edit/utilities alone', atUtilities);
      }
      return;
    }
    buildWorld(net);
  };
  /** The roads the next solve reads the ground under, worked out once a state of the network and solve (`roadsRead.ts`): with no solve to start from every road is read whatever the ground, with one the land has not moved (`landStill`), and a moved region is never kept. */
  const roadsRead = new RoadsRead<ReturnType<typeof roadsToRead>>();
  /** @rebuild The roads' heights solved again and the world's rebuild started (`worldSteps`). */
  const buildWorld = (net: Network): void => {
    const started = performance.now();
    // Only the roads changed (the land did not): the ground is cut and filled again only where the solve of the roads differs.
    const landStill = terrainRevision === net.doc.terrainRevision && elevation !== null;
    // Where the land moved (a stroke's region), when it can be said: the solve and the surfaces follow it there only.
    const land = landDirty;
    landDirty = null;
    const landBlocks = !landStill && land !== null && land !== 'all' ? blocksOver(land) : null;
    const groundMoved = landBlocks && land !== null && land !== 'all' ? [land] : null;
    const from = landStill || groundMoved ? elevation : null;
    // DO NOT read the ground under a tile's hundreds of new roads in this frame: a job reads it off the shared plates, the solve waits for it.
    const solvedAhead = offeredElevation !== null && offeredElevation.revision === net.revision && offeredElevation.terrain === net.doc.terrainRevision;
    stationsWait = !solvedAhead && roadStations.waiting(roadsRead.of(groundMoved ? null : [net.state, from], () => roadsToRead(net, builtGroundAt, from, groundMoved)),
      (terrain.renderedHeightAt as SharedGroundAt).share?.current ?? null, net.doc.terrainRevision);
    if (stationsWait) return;
    const previousElevation = elevation;
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;
    activeBuilt = activeSerial;

    // ONE solve for the whole network, shared by every consumer below.
    const offered = offeredElevation;
    offeredElevation = null;
    elevation = offered && offered.revision === net.revision && offered.terrain === terrainRevision
      ? offered.elevation
      // On land that has not moved, from the last solve
      : buildRoadElevation(net, builtGroundAt, from, roadStations.current, groundMoved);
    roadStations.used();
    measureHitch('hitch:road-edit/elevation', started);
    // Now the ground comes to meet the roads
    // The blocks the two solves differ in, digested off the page (`compareSolves`) and read by the job, which waits for them
    const compare = previousElevation && (landStill || landBlocks) ? compareSolves(previousElevation, elevation, landBlocks) : null;
    pendingBlocks = compare && !pendingBlocks.includes(null) ? [...pendingBlocks, compare] : [null];
    const elevationMs = performance.now() - started;
    const cause = net.doc.changes.version;
    // DO NOT build it in one go: the roads of a generated city were built in the frame of the change, on the page
    worldJob = worldSteps(net, pendingBlocks, { cause, elevationMs }, started, true);
    worldJobFresh = true;
    worldJobGround = true;
  };

  /** @rebuild What `worldSteps` builds before it is put in place at once. */
  function* worldSteps(net: Network, compares: readonly (BlockCompare | null)[], solved: { readonly cause: number; readonly elevationMs: number },
    started: number, sliced: boolean): Generator<'wait' | void, void, void> {
    const solve = elevation!;
    // The revision this build is of: what its landing says the near roads are built for (`settleNearTiles`).
    const builtOf = networkRevision;
    // The blocks the solves differ in, once the worker has digested them (`compareSolves`).
    while (compares.some((c) => c && !c.ready)) { groundWorkers.check(); yield 'wait'; }
    const own = compares[compares.length - 1] ?? null;
    const changed = own ? own.blocks : null;
    // In the diary: the roads' heights solved again where they differ, after the edit that moved them.
    worldCause = derived(net, 'elevation', changed, 'road heights solved', solved.cause,
      { ms: solved.elevationMs + (own?.ms ?? 0), detail: changed ? `${changed.length} blocks of ${SHAPE_BLOCK} u` : 'whole map' }) || solved.cause;
    // The roads' own heights (the footway, the carriageway) moved where the solve did
    // DO NOT shape the whole map when the blocks are known, however many: past a quarter of the plates loaded it re-floored and re-graded every building of the region at each tile the streamed world put in (5 floors a building in an opening, 2026-10-16); the blocks' work follows what moved.
    const blocks = compares.includes(null) ? null : compares.flatMap((c) => c!.blocks);
    if (blocks === null) {
      const shaping = shapeGround(net);
      while (!shaping.landed) { landShapes(); if (shaping.landed) break; yield 'wait'; }
    } else if (blocks.length || gradedFor !== net.doc.buildings.revision) yield* shapeBlocksSteps(net, blocks);
    pendingBlocks = [];
    worldJobGround = false;
    yield;
    // The tiles kept from the last session, read while the game started: a sliced build waits for them a little
    if (sliced && !storedRead) {
      const since = performance.now();
      while (!storedRead && performance.now() - since < KEPT_TILES_WAIT_MS) yield 'wait';
    }
    // Sliced, the tiles are shaped by the workers while the frames go on (`roadTilePool.ts`); built in one go
    // Only the tiles the changed blocks reach are digested again (`roadSurfaces.ts` `depends`): the blocks hold where the land moved too (`landBlocks`), null when that cannot be said.
    // The blocks every build since the last finished one changed (a build replaced halfway left its own for this one).
    surfaceBlocks = blocks !== null && surfaceBlocks !== null ? [...surfaceBlocks, ...blocks] : null;
    // THE STREAMED WORLD'S ROADS ARE THE TILES' (`farRoads.ts` near level: every tile one way, an edited one from the page's records): the region builds none to draw. Two ways of drawing them met at the region's edge, its detail on one side and the far level's flat colour on the other at the same distance (2026-10-16).
    const byTile = activeAt !== null;
    const freshRoads = byTile ? noRoadSurfaces() : yield* roadSurfaceSteps(net, solve, materials, terrain.renderedHeightAt, surfaceReuse, terrain.vergeMaterial,
      sliced ? roadTiles : null, surfaceBlocks);
    surfaceBlocks = [];
    if (!byTile) {
      derived(net, 'surfaces', freshRoads.rebuilt, 'road surfaces rebuilt', worldCause,
        { ms: freshRoads.workMs, detail: `${freshRoads.built} tiles built, ${freshRoads.reused} reused` });
    }
    // The structures' details, the poles and the street furniture are each kept as they are when the edit's blocks reach none
    // A streamed world's structures are the tiles' (`structureTiles.ts`, baked in workers): the region builds none, its cells let go.
    const atdetails = performance.now();
    if (byTile && details) { builtTriangles -= details.triangles; world.remove(details.group); details.dispose(); details = null; }
    const freshDetails = byTile ? null : (details ??= createStructureCells(materials, terrain.vergeMaterial, activeTiles)).prepare(net, solve, terrain.renderedHeightAt, blocks);
    measureHitch('hitch:road-edit/details', atdetails);
    yield;
    // The overhead utility network.
    const utilityBuilt = net.doc.utilityRevision;
    yield;

    // The new pieces' shaders compiled before they are drawn - in parallel where the driver can
    if (sliced) {
      const stage = new Group();
      for (const piece of [freshRoads.group, ...(freshDetails?.fresh ?? [])]) {
        if (piece.parent === null) stage.add(piece);
      }
      if (stage.children.length > 0) {
        let compiled = false;
        void compileAhead(stage).then(() => { compiled = true; });
        while (!compiled) yield 'wait';
      }
    }

    // Everything in place at once: the world as it was goes - only what is replaced here.
    let triangles = builtTriangles;
    if (roads && roads !== freshRoads) { triangles -= roads.triangles; world.remove(roads.group); roads.dispose(); }
    // The region's blocks of a world drawn by tiles now: let go once out of the picture.
    if (byTile && surfaceReuse.chunks.size) dropSurfaceBlocks(surfaceReuse);
    triangles -= details?.triangles ?? 0;
    for (const mesh of surfaceReuse.retired?.splice(0) ?? []) disposeMesh(mesh);
    roads = freshRoads;
    roads.adopt();
    world.add(roads.group);
    freshDetails?.apply();
    if (details && !details.group.parent) world.add(details.group);
    utilityRevision = utilityBuilt;
    builtTriangles = triangles + roads.triangles + (details?.triangles ?? 0);
    // The poles the edit reached, on the ground just put in place (`syncUtilities`, from the diary).
    const atutilities = performance.now();
    syncUtilities(net, poleGroundAt(solve, terrain.renderedHeightAt, net));
    measureHitch('hitch:road-edit/utilities', atutilities);
    // The street furniture and the signs follow from the diary once the world stands (the engine's 'draw' phase, in `draw`).
    rebuildMs = performance.now() - started;
    measureHitch('hitch:road-edit/world rebuilt', started);
    rebuilds++;
    landedRevision = builtOf;
    onAssetsReady();
  }

  /** The road shaders compiled before the first road is drawn. */
  let roadShadersWarm: 'no' | 'started' = 'no';
  /** @rebuild Once; every later frame returns at its first check. */
  const warmRoadShaders = (): void => {
    if (roadShadersWarm !== 'no') return;
    roadShadersWarm = 'started';
    try {
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      // Each class of road, a junction and a pedestrian crossing on one leg.
      [[m(70), 0, 0], [-m(70), 0, 1], [0, m(70), 2], [0, -m(70), 3]].forEach(([x, y, type]) => {
        doc.addSegment(doc.addNode({ x: x!, y: y! }).id, centre.id, type!);
      });
      const pole1 = doc.addPole({ x: m(20), y: m(12) }, true);
      const pole2 = doc.addPole({ x: m(50), y: m(12) }, false);
      doc.addPoleSpan(pole1.id, pole2.id);
      const warmNet = new Network(doc);
      warmNet.rebuild();
      const flat = (): number => 0;
      const warmElevation = buildRoadElevation(warmNet, flat);
      const group = new Group();
      const parts = [
        buildRoadSurfaces(warmNet, warmElevation, materials, flat, undefined, terrain.vergeMaterial),
        buildStructureDetails(warmNet, warmElevation, flat, materials),
        buildUtilities(warmNet, poleGroundAt(warmElevation, flat), sceneryKit),
      ];
      for (const part of parts) group.add(part.group);
      // And the street furniture's, the long grass's and the signs' meshes as their layers draw them, with their shadows
      const placedShadows = new Group();
      for (const mesh of [...furniture.warm(), ...signs.warm()]) {
        group.add(mesh);
        const standIn = shadowStandIn(mesh);
        if (standIn) placedShadows.add(standIn);
      }
      void compileAhead(placedShadows, true).then(() => placedShadows.clear());
      void compileAhead(group).then(() => {
        for (const part of parts) part.dispose();
      });
    } catch (error) {
      console.warn('road shader warm-up skipped', error);
    }
  };

  /** The shaders a blow first needs - a broken building's pieces */
  let blastShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmBlastShaders = (): void => {
    if (blastShadersWarm) return;
    blastShadersWarm = true;
    const kit = buildings.kit;
    const tiny = new BufferGeometry();
    tiny.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    tiny.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    tiny.setAttribute('color', new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    tiny.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    tiny.setAttribute('aDecay', new Float32BufferAttribute([0, 0, 0], 1));
    const group = new Group();
    const mats = [kit.shellMaterial, kit.ruinShell, kit.facade, ...Object.values(kit.material), kit.furniture().material, kit.massing];
    for (const mat of mats) {
      const mesh = new Mesh(tiny, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // In the scene for its lights, but never drawn
    group.visible = false;
    scene.add(group);
    void compileAhead(group).then(() => { scene.remove(group); tiny.dispose(); });
    // And every part as the layer draws it, instanced, with its shadow (`partWarmMeshes`)
    const parts = new Group();
    const partShadows = new Group();
    for (const mesh of partWarmMeshes(kit)) {
      parts.add(mesh);
      const standIn = shadowStandIn(mesh);
      if (standIn) partShadows.add(standIn);
    }
    parts.visible = false;
    scene.add(parts);
    void compileAhead(parts).then(() => { scene.remove(parts); parts.clear(); });
    void compileAhead(partShadows, true).then(() => partShadows.clear());
  };

  /** The tools' previews compiled ahead, as the roads' and the blows' are */
  let previewShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmPreviewShaders = (): void => {
    if (previewShadersWarm) return;
    previewShadersWarm = true;
    try {
      const group = new Group();
      const done: (() => void)[] = [];
      const blueprint = BLUEPRINTS[0];
      if (blueprint) {
        const sample = { ...instantiate(blueprint.body, { x: 0, y: 0 }, 0), id: -1 } as Building;
        const ghost = buildBuildingMeshes([sample], () => 0, buildings.kit, true);
        group.add(ghost.group);
        done.push(() => ghost.dispose());
        // And as a building grown on a lot draws it: its window panes carry their rooms' light slots
        const real = buildBuildingMeshes([sample], () => 0, buildings.kit, false);
        group.add(real.group);
        done.push(() => real.dispose());
        // And faded ("ocultar outros", `fade.ts`): the faded materials on parts with and without instance colours.
        const faded = buildBuildingMeshes([sample], () => 0, buildings.kit, false);
        fadeMeshes(faded.group, buildings.kit, true);
        group.add(faded.group);
        done.push(() => faded.dispose());
      }
      // The gardens' plants and their shadows, the first lots painted grow them.
      const plants = plantSamples(sceneryKit);
      group.add(plants.group);
      void compileAhead(plants.depth, true);
      done.push(() => plants.dispose());
      for (const mode of ['train', 'metro'] as const) {
        const track = buildTrackPreview([{ x: 0, y: 0 }, { x: m(60), y: 0 }], mode, () => 0);
        group.add(track.group);
        done.push(() => track.dispose());
      }
      // The lots need no program of their own: the ground's materials draw them (`lotOverlay.ts`).
      void compileAhead(group).then(() => { for (const finish of done) finish(); });
    } catch (error) {
      console.warn('preview shader warm-up skipped', error);
    }
  };

  const applyQuality = (level: QualityLevel, settings: QualitySettings = QUALITY[level]): void => {
    quality = settings;
    // The far woods as dense as the near ones, on the same budget (`farWoods.ts`).
    terrain.setVegetation?.(quality.vegetation);
    renderer.setPixelRatio(Math.min(WEAK_MACHINE.pixelRatio ?? (window.devicePixelRatio || 1), quality.pixelRatio));
    renderer.shadowMap.enabled = quality.shadows;
    materials.setDetail(quality.surfaceDetail);
    environment.setQuality({ shadows: quality.shadows, shadowMapSize: quality.shadowMapSize });
    post?.dispose();
    post = createPostChain(renderer, scene, rig.camera, quality, level);
    post.setNight(Math.max(0, lastDark));
    resize();
    // DO NOT force one with `networkRevision = -1`
    shadowMoved = true;
  };

  let post: PostChain = createPostChain(renderer, scene, rig.camera, quality, governor.current);
  renderer.setPixelRatio(Math.min(WEAK_MACHINE.pixelRatio ?? (window.devicePixelRatio || 1), quality.pixelRatio));

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    rig.resize(width, height);
    post.setSize(width, height, renderer.getPixelRatio());
    // The GPU's cap from the device and the drawing buffer's pixels, and the frame's targets in the ledger (`gpuLedger.ts`).
    gpuLedger.cap = deviceGpuCap(readGpuDevice(renderer.getContext(), canvas.width * canvas.height));
    gpuLedger.set('render targets', 'render targets', renderTargetsBytes(post.targets()));
  }
  resize();

  const target = new Vector3();
  let fps = 60;
  /** Wall-clock seconds, for the wind; independent of the simulation speed. */
  let windClock = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  // Development only: the production build replaces the flag with false and drops the inspector with it.
  const inspect = import.meta.env.DEV ? createInspector(renderer, scene) : null;
  let lotOverlay: ReturnType<typeof createLotOverlay> | null = null;
  let transitXray = false;
  let transitPreview: TrackPreview | null = null;
  let transitPreviewKey = '';

  /** The map zoom and the plant layers `setMap` was last told about (`draw`). */
  let plantMapFor: { map: boolean | null; gardens: Gardens | null } = { map: null, gardens: null };
  /** In perspective: how far down the street a person or a car is still big enough to see appear, u. */
  const VIEW_SEEN = m(320);
  /** In perspective: radians added to each side of the camera's width (the camera turns). */
  const VIEW_MARGIN = 0.35;
  /** What grows of itself on a map with an ecosystem (`world/ecology.ts`) */
  const NATURE_SPACING = WOODS_SPACING;
  /** Trees the ecosystem grows at full vegetation quality (the forests take most). */
  const NATURE_TREES = 2_500;
  /** The ecosystem's sweep: each plate's trees as picked (DO NOT join every plate's into one list: nothing reads it, and it was made again at each sweep). */
  interface NatureSweep {
    readonly key: string;
    /** Plates left to sweep (one is swept a frame): the sweep runs again next frame while any is. */
    readonly pending?: number;
    /** The plates swept, each filed with its own trees (`fileNature`). */
    readonly slices?: readonly { readonly plate: NaturePlate }[];
  }
  /** One plate's tree density as last swept, and what it was swept for (`natureSweep`), by surface. */
  interface NaturePlate {
    readonly key: string; readonly part: TerrainPart; readonly odds: Float32Array; readonly band: Uint8Array; readonly di: number; readonly dj: number; readonly sum: number;
    /** Its trees as last picked, and the scale they were picked at: picked again only when either moved. */
    picked: { readonly scale: number; readonly trees: readonly Candidate[] } | null;
    /** The trees of `picked` kept on open ground (its own indices, their ground), and what they were kept for. */
    kept: { readonly key: string; readonly of: readonly Candidate[]; readonly idx: readonly number[]; readonly z: readonly number[] } | null;
  }
  const naturePlates = new WeakMap<object, NaturePlate>();
  /** DO NOT key every plate's sweep on the document's terrain revision */
  const plateLandRead = new JournalCursor(['terrain']);
  const plateLand = new WeakMap<object, number>();
  let landSerial = 0;
  const bringPlateLand = (doc: RoadDoc): void => {
    const entries = plateLandRead.read(doc.changes);
    if (entries !== null && entries.length === 0) return;
    for (const part of terrain.parts) {
      const box: ChangeRect = [part.cx - TERRAIN_HALF - TERRAIN_CELL, part.cy - TERRAIN_HALF - TERRAIN_CELL, part.cx + TERRAIN_HALF + TERRAIN_CELL, part.cy + TERRAIN_HALF + TERRAIN_CELL];
      const reached = entries === null || entries.some((e) => e.rects === null || e.rects.some((r) => r[0] <= box[2] && r[2] >= box[0] && r[1] <= box[3] && r[3] >= box[1]));
      if (reached) plateLand.set(part.surface, ++landSerial);
    }
  };
  const natureSweep = (key: string): NatureSweep => {
    if (quality.vegetation <= 0 || !terrain.parts.some((p) => p.surface.ecology())) return { key };
    // A plate whose woods' base is not in yet waits for it (`terrain.ts` keeps it with the land): DO NOT work a plate's density out here, a plate a frame - 35 ms of the page each.
    let pending = 0;
    // THE TREE MAP, as Horizon Zero Dawn's Placement_Trees (Guerrilla, GDC 2017)
    const cells = Math.floor((TERRAIN_HALF * 2) / NATURE_SPACING);
    const plates: NaturePlate[] = [];
    let treeSum = 0;
    // What a plate's density reads besides its own ecology: its own land (`plateLand`) and the vegetation setting.
    const vegetation = quality.vegetation;
    for (const part of terrain.parts) {
      const field = part.surface.ecology();
      if (!field) continue;
      // Kept from the last sweep while its own ecology and the land are as they were
      const plateKey = `${part.surface.ecologyRevision}:${part.surface.woodsRevision ?? 0}:${plateLand.get(part.surface) ?? 0}:${vegetation}`;
      const known = naturePlates.get(part.surface);
      if (known && known.key === plateKey) {
        plates.push(known);
        treeSum += known.sum;
        continue;
      }
      // Its density but the ecosystem's share, kept by the plate on its land (`woodsBase.ts`): only that share added here.
      const base = part.surface.woodsBase?.() ?? null;
      if (!base) { pending++; continue; }
      const odds = known?.odds ?? new Float32Array(cells * cells);
      const band = known?.band ?? new Uint8Array(cells * cells);
      let plateSum = 0;
      const di = Math.round(part.cx / NATURE_SPACING), dj = Math.round(part.cy / NATURE_SPACING);
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const x = -TERRAIN_HALF + (i + 0.5) * NATURE_SPACING, y = -TERRAIN_HALF + (j + 0.5) * NATURE_SPACING;
          const ix = Math.round((x + TERRAIN_HALF) / TERRAIN_CELL), iy = Math.round((TERRAIN_HALF - y) / TERRAIN_CELL);
          const k = iy * field.side + ix;
          const ecology = Math.min(1, (field.canopy[k] ?? 0) * 0.9 + (field.trees[k] ?? 0) * 0.5 + (field.emergent[k] ?? 0) * 0.3);
          const o = j * cells + i;
          // Nothing grows past the map's edge (`wholeMap.ts`).
          if (!onMap(x + part.cx, y + part.cy)) { odds[o] = 0; band[o] = 0; continue; }
          // `natureDensity` is linear in the ecology: the base (the land's slope and the patches, `woodsBase.ts`) and its share.
          const density = base[o]! + ecology * 0.3;
          // The bands: inner forest, its edge, scattered trees, a rare lone one.
          if (density > 0.62) { odds[o] = 0.92; band[o] = 3; }
          else if (density > 0.5) { odds[o] = 0.25 + (density - 0.5) / 0.12 * 0.6; band[o] = 2; }
          else if (density > 0.38) { odds[o] = 0.025; band[o] = 1; }
          else { odds[o] = 0.003; band[o] = 1; }
          plateSum += odds[o]!;
        }
      }
      const plate: NaturePlate = { key: plateKey, part, odds, band, di, dj, sum: plateSum, picked: null, kept: null };
      naturePlates.set(part.surface, plate);
      plates.push(plate);
      treeSum += plateSum;
    }
    // The woods as thick on each plate: the plates' trees scaled to the budget by their mean.
    const plateArea = (2 * TERRAIN_HALF) ** 2;
    const base = NATURE_TREES * Math.min(1, quality.vegetation / 2_600);
    const plannedSum = (treeSum / Math.max(1, plates.length)) * (m(1_920) ** 2 / plateArea);
    // In steps of 2 %: a plate brought in nudges the average
    const treeScale = Math.min(1, Math.exp(Math.round(Math.log(base / Math.max(1, plannedSum)) / 0.02) * 0.02));
    const slices: { plate: NaturePlate }[] = [];
    for (const plate of plates) {
      if (plate.picked && plate.picked.scale === treeScale) {
        slices.push({ plate });
        continue;
      }
      const { part, odds, band, di, dj } = plate;
      const mine: Candidate[] = [];
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const o = j * cells + i;
          const gi = i + di, gj = j + dj;
          if (cellHash(gi, gj, 41) >= odds[o]! * treeScale) continue;
          const x = part.cx - TERRAIN_HALF + (i + 0.5 + (cellHash(gi, gj, 43) - 0.5) * 0.9) * NATURE_SPACING;
          const y = part.cy - TERRAIN_HALF + (j + 0.5 + (cellHash(gi, gj, 44) - 0.5) * 0.9) * NATURE_SPACING;
          // Tall in the heart of a wood, crowns meeting into one canopy; lower at its edge; short and crooked out in the open.
          const inner = band[o] === 3, edge = band[o] === 2;
          const h = inner ? m(11) + m(8) * cellHash(gi, gj, 45) : edge ? m(8) + m(6) * cellHash(gi, gj, 45) : m(5.5) + m(4) * cellHash(gi, gj, 45);
          const roll = cellHash(gi, gj, 46);
          const species = inner ? (roll < 0.6 ? 'broadleafTall' : 'broadleaf') : roll < 0.25 ? 'broadleafTall' : 'broadleaf';
          // Which of the low-poly trees (`natureTrees.ts`): oaks and cypresses most, a palm now and then out in the open.
          const pick = cellHash(gi, gj, 49);
          const kind = pick < 0.55 ? 'oak' : pick < (inner ? 0.97 : 0.85) ? 'cypress' : 'palm';
          mine.push({ x, y, size: h, yaw: cellHash(gi, gj, 47) * Math.PI * 2, seed: seedOfKind(kind, cellHash(gi, gj, 48)), species });
        }
      }
      plate.picked = { scale: treeScale, trees: mine };
      slices.push({ plate });
    }
    return { key, pending, slices };
  };
  /** DO NOT make it at every keep - a keep runs at every road, building and terrain edit */
  let clearingsFor = -1;
  let clearingsDoc: RoadDoc | null = null;
  /** The clearings by place, filed one cut at a time (`clearingCells.ts`). */
  const clearingCells = new ClearingCells();
  const inClearing = (x: number, y: number): boolean => clearingCells.has(x, y);
  const clearingsOf = (doc: RoadDoc): ((x: number, y: number) => boolean) => {
    if (clearingsDoc !== doc || clearingsFor !== doc.clearingRevision) {
      clearingsDoc = doc;
      clearingsFor = doc.clearingRevision;
      clearingCells.follow(doc, doc.treeClearings);
    }
    return inClearing;
  };
  /** Water, a cliff, a road or a building: nothing of the ecosystem grows there. */
  const natureOpen = (net: Network, x: number, y: number, z: number): boolean => {
    // Off its plate's edge strip (the plate's centre worked out, no object a candidate).
    const cx = Math.floor(x / PLATE_SIZE + 0.5) * PLATE_SIZE, cy = Math.floor(y / PLATE_SIZE + 0.5) * PLATE_SIZE;
    if (Math.abs(x - cx) > PLATE_SIZE / 2 - m(2) || Math.abs(y - cy) > PLATE_SIZE / 2 - m(2)) return false;
    const level = terrain.shoreLevelAt(x, y);
    if (level !== null && level > z - m(0.3)) return false;
    const g = m(2);
    const grade = Math.hypot(terrain.renderedHeightAt(x + g, y) - terrain.renderedHeightAt(x - g, y), terrain.renderedHeightAt(x, y + g) - terrain.renderedHeightAt(x, y - g)) / (2 * g);
    if (grade > 0.75) return false;
    return !onCarriageway(net, { x, y }) && !buildings.covers(x, y);
  };
  /** How far round a place its test reads (the slope's samples, a margin): a change within it tests the place again. */
  const KEEP_REACH = m(4);
  /** A tree of the ecosystem stands on open ground, out of the clearings: its ground, or null. */
  const natureStands = (c: Candidate): number | null => {
    const net = keepNet!;
    const at = terrain.renderedHeightAt(c.x, c.y);
    return natureOpen(net, c.x, c.y, at) && !clearingsOf(net.doc)(c.x, c.y) ? at : null;
  };
  /** Which of the ecosystem's swept trees stand, cell by cell (`cellKeeps.ts`), and the trees each plate's cells were filled from. */
  const natureKeeps = new CellKeeps<Candidate>(natureStands);
  const natureFiled = new Map<object, { readonly trees: readonly Candidate[]; readonly cells: readonly number[] }>();
  /** DO NOT test and draw every tree of the ecosystem again for one plate swept again: the cells of the plates whose trees changed */
  const fileNature = (sweep: NatureSweep): void => {
    const swept = new Set<object>();
    for (const { plate } of sweep.slices ?? []) {
      const surface = plate.part.surface;
      swept.add(surface);
      const trees = plate.picked?.trees ?? [];
      const was = natureFiled.get(surface);
      if (was?.trees === trees) continue;
      const byCell = new Map<number, Candidate[]>();
      for (const t of trees) {
        const key = keepCellAt(t.x, t.y);
        const list = byCell.get(key);
        if (list) list.push(t); else byCell.set(key, [t]);
      }
      for (const key of was?.cells ?? []) if (!byCell.has(key)) natureKeeps.fill(key, []);
      // A cell whose trees came out the same keeps them standing as they are: neither tested nor drawn again.
      for (const [key, list] of byCell) natureKeeps.fill(key, list, sameCandidate);
      natureFiled.set(surface, { trees, cells: [...byCell.keys()] });
    }
    // The plates no longer swept (no ecosystem, or no vegetation): their cells let go.
    for (const [surface, was] of natureFiled) {
      if (swept.has(surface)) continue;
      for (const key of was.cells) natureKeeps.fill(key, []);
      natureFiled.delete(surface);
    }
  };
  /** A cover's place: never on a road or under a building. */
  const coverFree = (x: number, y: number): boolean => !onCarriageway(keepNet!, { x, y }) && !buildings.covers(x, y);
  const coverPlain = (c: Candidate): number | null => (coverFree(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null);
  /** Which of the painted covers' and the rivers' places stand, kind by kind and cell by cell (`cellKeeps.ts`). */
  const coverKeeps = {
    // The woods out of the clearings.
    forest: new CellKeeps<Candidate>((c) => (coverFree(c.x, c.y) && !clearingsOf(keepNet!.doc)(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null)),
    scrub: new CellKeeps<Candidate>(coverPlain),
    rocks: new CellKeeps<Candidate>(coverPlain),
    // A river's stone by its height over the water: thickest at the waterline, thinning up the bank and into the deep.
    shore: new CellKeeps<ShoreCandidate>((c) => {
      const ground = terrain.renderedHeightAt(c.x, c.y);
      const above = ground - c.level;
      const odds = above < -m(2.5) ? 0.06 : above < -m(0.3) ? 0.3 : above < m(0.6) ? 0.45 : above < m(2) ? 0.22 : above < m(4) ? 0.07 : 0;
      return c.draw <= odds && coverFree(c.x, c.y) ? ground : null;
    }),
  };
  /** The four kinds as the draw walks them: refreshed, and their changed cells taken, alike. */
  const coverKinds: readonly Pick<CellKeeps<Candidate>, 'refresh' | 'refreshAll' | 'takeChangedCells'>[] = [coverKeeps.forest, coverKeeps.scrub, coverKeeps.rocks, coverKeeps.shore];
  /** @rebuild Every cell of every kind: only when every cell is drawn again. */
  const allCoverCells = (): Set<number> => new Set([...coverKeeps.forest.cellKeys(), ...coverKeeps.scrub.cellKeys(), ...coverKeeps.rocks.cellKeys(), ...coverKeeps.shore.cellKeys()]);
  /** Which of the trees the player planted stand: off the roads, out of the buildings. */
  const plantedKeeps = new CellKeeps<PlantedTree>((t) => (onCarriageway(keepNet!, t) || buildings.covers(t.x, t.y) ? null : terrain.renderedHeightAt(t.x, t.y)));
  /** The planted trees standing in a keep cell, from the document's filing by place (`RoadDoc.treesIn`); none in a cell of the kept ring (`ActiveTiles.keepsCell`). */
  /** A keep cell whose tile's planted trees the tiles draw (`plantedTiles.ts`): the region files none there; until that tile's bake lands the region draws them (never a hole while it is baked). */
  const plantedByTile = (key: number): boolean => { const r = keepCellRect(key); return nearTiles.landed('planted', tileKeyAt((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)); };
  const plantedIn = (doc: RoadDoc, key: number): PlantedTree[] => (activeTiles.keepsCell(key) && !plantedByTile(key) ? doc.treesIn(keepCellRect(key)).filter((t) => keepCellAt(t.x, t.y) === key) : []);
  /** The tiles whose planted bake came or went since the region last filed its trees: their cells filed again. */
  const plantedFlips = new Set<number>();
  nearTiles.onLanded = (kind, tile) => { if (kind === 'planted') { plantedFlips.add(tile); onAssetsReady(); } };
  /** The planted forest's cells, made once the woods' models are in: the region's keep draws in them, and a streamed world's tiles (`plantedTiles.ts`). */
  const plantedForestOf = (): PlantCells | null => {
    if (!natureTreeKit) return null;
    const kit = natureTreeKit;
    return plantedForest ??= (() => {
      const made = createTreeCells(kit, 'planted-forest', (cell) => plantedKeeps.standingIn(cell)
        .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.height, yaw: c.yaw, seed: c.seed, species: 'broadleaf' as const })));
      world.add(made.group);
      return made;
    })();
  };
  // The streamed world's planted trees per tile, in the planted forest's cells.
  nearTiles.add(plantedProduct(plantedForestOf, () => natureTreeKit?.variants.length ?? 0));
  // The streamed world's road structures per tile (`structureTiles.ts`): piers, parapets, retaining walls, portals.
  nearTiles.add(structureProduct(world, materials, terrain.vergeMaterial));
  /** @rebuild Every planted tree filed cell by cell: the map opened, or its trees replaced whole. */
  const plantAll = (doc: RoadDoc): void => {
    plantedKeeps.clear();
    const byCell = new Map<number, PlantedTree[]>();
    for (const t of doc.trees) {
      const key = keepCellAt(t.x, t.y);
      const list = byCell.get(key);
      if (list) list.push(t); else byCell.set(key, [t]);
    }
    for (const [key, list] of byCell) if (activeTiles.keepsCell(key) && !plantedByTile(key)) plantedKeeps.fill(key, list);
  };
  /** What the cover sweeps read of the ground (`coverSweep.ts`). */
  const coverField: CoverField = {
    forestAt: (x, y) => terrain.forestAt(x, y),
    coverAt: (kind, x, y) => terrain.coverAt(kind, x, y),
    shoreLevelAt: (x, y) => terrain.shoreLevelAt(x, y),
  };
  /** The painted covers of keep cells swept again, each cell's places kept as they stand where the sweep finds the same. */
  const resweepCovers = (cells: Iterable<number>): void => {
    for (const key of cells) {
      // A cell of the kept ring round the active tiles: its covers let go (`ActiveTiles.keepsCell`).
      const kept = activeTiles.keepsCell(key);
      coverKeeps.forest.fill(key, kept ? forestIn(key, coverField) : [], sameCandidate);
      coverKeeps.scrub.fill(key, kept ? scrubIn(key, coverField) : [], sameCandidate);
      coverKeeps.rocks.fill(key, kept ? rocksIn(key, coverField) : [], sameCandidate);
    }
  };
  /** @rebuild The painted covers swept over every cover dab of the map (opened, replaced, or a change the diary cannot place). */
  const sweepAllCovers = (doc: RoadDoc): void => {
    for (const keep of [coverKeeps.forest, coverKeeps.scrub, coverKeeps.rocks]) keep.clear();
    const cells = new Set<number>();
    for (const dab of doc.terrainPaint) {
      if (isCoverKind(dab.kind)) keepCellsOver([dab.x - dab.radius, dab.y - dab.radius, dab.x + dab.radius, dab.y + dab.radius], COVER_SWEEP_PAD, cells);
    }
    resweepCovers(cells);
  };
  /** The rivers' stones plate by plate (`ShorePlates`): a plate come in, or whose water changed, sweeps its own cells; one gone lets them go. */
  const shorePlates = new ShorePlates((key, water) => coverKeeps.shore.fill(key, shoreIn(key, coverField, water), sameShore));
  /** The cover layer's cells (stones, scrub, card trees), made once: the region's keeps draw in them, and a streamed world's tiles (`coverTiles.ts`). */
  const coverCellsOf = (): PlantCells => coverCells ??= (() => {
    const made = createCoverCells(coverKit, 'ground-cover', {
      rocksIn: (cell) => [...coverKeeps.rocks.standingIn(cell), ...coverKeeps.shore.standingIn(cell)]
        .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed, rock: terrain.geologyAt(c.x, c.y) })),
      scrubIn: (cell) => coverKeeps.scrub.standingIn(cell).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed })),
      treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? coverKeeps.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
    });
    world.add(made.group);
    return made;
  })();
  /** The painted woods' low-poly trees (`natureTrees.ts`), made once the woods' models are in. */
  const paintedForestOf = (): PlantCells | null => {
    if (!natureTreeKit) return null;
    const kit = natureTreeKit;
    return paintedForest ??= (() => {
      const made = createTreeCells(kit, 'painted-forest', (cell) => coverKeeps.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
      world.add(made.group);
      return made;
    })();
  };
  /** The region's painted cover let go for the tiles' (a streamed world open). */
  let coverTiled = false;
  // The streamed world's painted cover per tile (`coverTiles.ts`): its stones and scrub in the cover's cells, its woods in the painted forest's.
  nearTiles.add(coverProduct({
    coverCells: coverCellsOf,
    forest: paintedForestOf,
    version: () => `${!natureTreeKit && !natureTreesPending ? 'cards' : 'trees'}:${natureTreeKit?.variants.length ?? 0}`,
    extra: (tile) => coverExtraFor(tile, coverKit, natureTreeKit?.variants.length ?? 0, !natureTreeKit && !natureTreesPending, worldNet?.doc.treeClearings ?? []),
  }));
  const handle: SceneHandle = {
    // Asked for by the Actions (a shot, a bomb) and the weapons lab: the effects, and now the physics the bodies fall with
    effects: () => loadEffects().then(() => import('./ragdoll')).then((mod) => mod.warmPhysics()),
    flashGrid(cells) {
      if (!cells.length) return;
      const pos: number[] = [], ring: number[] = [];
      const lift = m(0.3), sub = 4, d = GRID_CELL / sub;
      for (const c of cells) {
        // Each cell in 4 x 4 pieces on the ground, so it bends with it.
        for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
          const x0 = c.x + i * d, y0 = c.y + j * d, x1 = x0 + d, y1 = y0 + d;
          const v = (x: number, y: number): void => { pos.push(x, terrain.renderedHeightAt(x, y) + lift, -y); ring.push(c.ring); };
          v(x0, y0); v(x1, y0); v(x1, y1); v(x0, y0); v(x1, y1); v(x0, y1);
        }
      }
      addBlink(pos, ring);
    },
    flashRoads(ids) {
      // Built in the next frame, once the new roads' heights are solved (`draw`).
      pendingRoadFlash.push(...ids);
      pendingStandIn.push(...ids);
      onAssetsReady();
    },
    setGrid(on) {
      // Drawn by the ground's own material (`TERRAIN_GRID`): always on it, over any ground, in world units.
      TERRAIN_GRID.value = [GRID_CELL, on ? 0.08 : 0];
      if (on !== gridWanted) { gridWanted = on; onAssetsReady(); }
    },
    shootBody: (a, b) => fx?.shootBody(a, b) ?? null,
    isDown: (id) => fx?.hides(id) ?? false,
    setEffectsSpeed(speed) { fx?.setEffectsSpeed(speed); },
    stepEffects(seconds) { fx?.stepEffects(seconds); },
    ragdollProbe: () => fx?.ragdollProbe() ?? [],
    clearCasualties() { fx?.clearCasualties(); },
    meshProbe: () => agents.meshProbe(),
    animProbe: (id) => agents.animProbe(id),
    forceClip: (id, clip) => agents.forceClip(id, clip as never),
    driverBody: (vehicle, x, y) => agents.driverBody(vehicle, x, y),
    vehicleHit(x, y, z, dirX, dirY, glass, blood) { fx?.vehicleHit(x, y, z, dirX, dirY, glass, blood); },
    dropVehicle(v) { fx?.dropVehicle(v); },
    wound(x, y, z, dirX, dirY, severed) { fx?.wound(x, y, z, dirX, dirY, severed); },
    shot(from, to) { fx?.shot(from, to); },
    inspect,
    census: () => agents.census(),
    backend: 'three-webgl',
    viewport: rig.viewport,
    scene,
    gl: renderer,
    gpu: gpuTimer,
    get stats(): RenderStats {
      return {
        triangles: builtTriangles + buildings.triangles,
        drawCalls: renderer.info.render.calls,
        quality: governor.current,
        fps: Math.round(fps),
        rebuildMs: Math.round(rebuildMs),
        roadTiles: roads ? { built: roads.built, reused: roads.reused } : { built: 0, reused: 0 },
        rebuilds,
        terrainMs: Math.round(terrainMs),
      };
    },
    terrainHeightAt(x, y) {
      return terrain.renderedHeightAt(x, y);
    },
    landTop() {
      if (landTopFor !== landVersion) {
        landTopFor = landVersion;
        // Kept by the atlas as its plates' ground moves
        let top = terrain.highest?.() ?? -Infinity;
        const corners = Math.round((TERRAIN_HALF * 2) / TERRAIN_CELL);
        if (!terrain.highest) for (const part of terrain.parts) {
          for (let j = 0; j <= corners; j++) {
            for (let i = 0; i <= corners; i++) top = Math.max(top, part.surface.renderedHeightAt(-TERRAIN_HALF + i * TERRAIN_CELL, TERRAIN_HALF - j * TERRAIN_CELL));
          }
        }
        landTopValue = top;
      }
      return landTopValue;
    },
    builtGroundAt(x, y) {
      return builtGroundAt(x, y);
    },
    get worldBusy() {
      return worldJob !== null || stationsWait;
    },
    get opening() {
      return !reveal.opened;
    },
    get programsReady() {
      return programs.ready;
    },
    tileLoaded(key, rect, revision) {
      nearPending.set(key, { rect, revision });
    },
    tileLetGo(key) {
      nearPending.delete(key);
    },
    nearDrawn(key) {
      return !nearPending.has(key);
    },
    get farReach() {
      return farRoads.reachNow;
    },
    farSees(x0, y0, x1, y1) {
      // Three's axes: the plan's y is -z.
      seenBox.min.set(x0, -m(50), -y1);
      seenBox.max.set(x1, m(500), -y0);
      return detailFrustum.intersectsBox(seenBox);
    },
    get onNearDrawn() { return onNearDrawn; },
    set onNearDrawn(fn) { onNearDrawn = fn; },
    setActiveTiles(at, rects) {
      buildings.setActive(at, rects);
      // The furniture and the signs of a streamed world are the tiles' (`nearTiles`): the page's own let go.
      furniture.setTiled(at !== null);
      signs.setTiled(at !== null);
      barriers.setTiled(at !== null);
      plantLists.setTiled(at !== null);
      // The other near products (gardens, furniture, signs, walls, poles, structures, planted trees, covers, elements, lots) take in or let go the tiles that came or left (`activeTiles.ts`).
      activeTiles.set(at, rects);
      // The near roads built again for the tiles that came in or left (`rebuildWorld`: the kept tiles' digests stand, only the flipped tiles are made or let go).
      if (rects.length || at === null) activeSerial++;
      activeAt = at;
      // Where the near roads start or stop: the next finished build visits those road tiles (none known when the region goes: every tile).
      if (at === null) surfaceReuse.withinMoved = null;
      else surfaceReuse.withinMoved?.push(...rects);
      if (rects.length) onAssetsReady();
    },
    holdOpening(until) {
      openingHeld = until;
    },
    get farBuildings() {
      return buildings.far;
    },
    get farRoads() {
      return roadsAndNear;
    },
    farBakeEnv() {
      return { ...buildings.farEnv(), massPrefix: buildings.far.bakePrefix, nearPrefix: nearTiles.bakePrefix };
    },
    beginLoad() {
      reveal.begin();
      programs.begin();
      openingSince = null;
      openingPrograms = 'no';
      onAssetsReady();
    },
    offerElevation(solved, revision) {
      offeredElevation = { elevation: solved, revision, terrain: terrainRevision };
    },
    roadsSolve() {
      return elevation ? { elevation, terrainRevision } : null;
    },
    surfaceHeightAt(x, y) {
      const ground = terrain.renderedHeightAt(x, y);
      if (!elevation) return ground;
      let top = ground;
      // The road at grade and the decks are asked apart
      for (const set of SURFACE_SETS) {
        if (!elevation.has(set)) continue;
        const road = elevation.roadAt(x, y, set);
        if (road.type < 0 || Math.abs(road.across) > road.half) continue;
        top = Math.max(top, elevation.at(x, y, set));
      }
      return top;
    },
    pavedHeightAt,
    setBuildingPreview(preview) {
      buildings.setPreview(preview);
    },
    strikeBuilding: (b, x, y, z, strength) => fx?.strikeBuilding(b, x, y, z, strength) ?? false,
    strikeGround(x, y, strength) {
      for (let k = 0; k < 6 + strength * 2; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * m(0.6 + strength * 0.25);
        wear.wheels(x + Math.cos(a) * r, y + Math.sin(a) * r, a, 0.01, 30);
      }
      wear.tick(10);
      exhaust.burst(x, y, terrain.renderedHeightAt(x, y), 20 + strength * 6, 1, m(1 + strength * 0.4), m(3), 5);
    },
    explode(x, y, z, radius, hit) { fx?.explode(x, y, z, radius, hit); },
    burn: (x, y, z, size, seconds) => fx?.burn(x, y, z, size, seconds),
    soot: (x, y, z, r) => fx?.soot(x, y, z, r),
    geyser: (x, y, z, seconds) => fx?.geyser(x, y, z, seconds),
    sparkAt: (x, y, z, seconds) => fx?.sparkAt(x, y, z, seconds),
    leak: (x, y, z, seconds) => fx?.leak(x, y, z, seconds),
    onBuildingDown: (listener) => { buildingDownListeners.push(listener); },
    flingOccupants: (list) => { fx?.flingOccupants(list); },
    setSmog: (k) => environment.setSmog(k),
    strikeAt: (x, y) => strikeAt(x, y),
    onStrike(listener) { strikeListeners.push(listener); },
    cloudDrift: () => cloudDrift,
    // A plate of the ground still on its way to the view (`flatAtlas.ts` waiting): drawn on until it is in, a still camera too.
    busy: () => (fx?.busy() ?? false) || natureTreesPending || cameraEasing || (terrain.waiting?.() ?? false),
    targetBytes: () => renderTargetsBytes([...post.targets(), ...environment.shadowMaps()]),
    buildingDetailBytes: () => buildings.residentBytes,
    drifting: () => ((fogMoving || placedCloudsShown) && post.enabled && (quality.cloudShadows || quality.skyClouds)) || weatherActive,
    forgetRuin(id) { fx?.forgetRuin(id); },
    setTransitXray(on) {
      transitXray = on;
      transit.setXray(on);
    },
    setTransitPreview(preview) {
      const key = preview ? `${preview.mode}:${preview.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}` : '';
      if (key === transitPreviewKey) return;
      transitPreviewKey = key;
      // ONE preview for the tool's life, written again as the track changes (`createTrackPreview`).
      if (!transitPreview) {
        transitPreview = createTrackPreview();
        world.add(transitPreview.group);
      }
      transitPreview.set(preview?.points ?? [], preview?.mode ?? 'train', terrain.renderedHeightAt, pavedHeightAt);
    },
    setLotOverlay(input, changes) {
      lotOverlay ??= createLotOverlay((x, y) => handle.surfaceHeightAt(x, y), activeTiles);
      lotOverlay.set(input, changes);
    },
    setPolePreview(net, preview) {
      const key = preview && elevation
        ? `${net.revision}:${preview.poles.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${+p.lamp},${+p.standing}`).join(';')}`
        : '';
      if (key === polePreviewKey) return;
      polePreviewKey = key;
      if (polePreview) {
        world.remove(polePreview.group);
        polePreview.dispose();
        polePreview = null;
      }
      if (!preview || !elevation || preview.poles.length === 0) return;
      polePreview = buildPolePreview(net, poleGroundAt(elevation, terrain.renderedHeightAt, net), sceneryKit, preview);
      world.add(polePreview.group);
    },
    setPerspective(on) {
      if (on === rig.perspective) return;
      rig.setPerspective(on);
      // The passes hold the camera they were made with.
      post.dispose();
      post = createPostChain(renderer, scene, rig.camera, quality, governor.current);
      post.setNight(Math.max(0, lastDark));
      resize();
      onAssetsReady();
    },
    setSkyMode(mode) {
      // Read by the next frame drawn.
      skyMode = mode;
    },
    setAtmosphere(next) {
      atmosphere = next;
    },
    setBuildingCutaway(spec) {
      buildings.setCutaway(spec);
      cutSpec = spec;
    },
    setBuildingsDimmed(except) {
      buildings.setDimmed(except === undefined ? undefined : (except as BuildingId | null));
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    // Wall-clock time between drawn frames, for things that age as they are watched.
    draw(net, sim, alpha, delta, options) {
      renderer.info.reset();
      groundDiary = net.doc.changes;
      // Planted trees and shrubs grow with the city's clock: resized once a city hour.
      cityMinutes = sim.minutes;
      const wallNow = performance.now();
      const wallDt = lastWall < 0 ? 0 : Math.min(0.1, (wallNow - lastWall) / 1000);
      // The bodies, guts and debris on their own clock
      const fxDt = fx ? fx.clock(wallDt) : 0;
      lastWall = wallNow;
      cameraEasing = rig.settle(wallDt);
      // Without an observer (none in this browser): read once here, as the frame did before.
      if (!sizeWatch) { css.w = canvas.clientWidth; css.h = canvas.clientHeight; }
      if (css.w !== lastWidth || css.h !== lastHeight) {
        lastWidth = css.w;
        lastHeight = css.h;
        resize();
      }
      const terrainStarted = performance.now();
      const stroking = !!options?.holdRoads && !!elevation && networkRevision === net.revision;
      const groundMoved = terrain.update(net.doc, stroking);
      const landEntries = landRead.read(net.doc.changes);
      if (groundMoved) {
        landVersion++;
        // The stroke's dirty region, dab by dab (`landDirty`); a rewrite the terrain cannot place (an undo of the relief), where the diary says it moved.
        const moved = terrain.lastRegion;
        const said = moved === null ? landMovedSince(landEntries) : regionRect(moved);
        landDirty = said === null || landDirty === 'all' ? 'all' : unionRect(landDirty, said);
      }
      terrain.updatePaint(net.doc);
      // A brush stroke in progress: every dab used to re-solve the whole road network and re-mesh every road
      if (stroking) {
        if (groundMoved) {
          shapeGround(net, terrain.lastRegion);
          terrainMs = performance.now() - terrainStarted;
        }
      } else {
        const atRebuild = performance.now();
        rebuildWorld(net);
        measureHitch('hitch:draw/Rebuild', atRebuild);
        terrain.settle();
      }
      const atPump = performance.now();
      pumpWorld();
      measureHitch('hitch:draw/Pump', atPump);
      // A building placed, moved or reshaped grades its own site.
      landShapes();
      followFloors(net);
      if (!(worldJob && worldJobGround) && gradedFor !== net.doc.buildings.revision) {
        gradedFor = net.doc.buildings.revision;
        const changed = sitesGraded.changedSites(net.doc.buildings);
        if (changed) shapeGround(net, changed.map(terrainRegion), true);
      }
      // What stands on the ground - the buildings, the walls, the transport, the gardens
      const groundSettled = !stroking && !worldJob;
      // The street furniture, the signs, the barriers and the transport on the world as it stands (the engine's 'draw' products)
      if (groundSettled) { placedOn = net; engine.refresh('draw'); }
      // The buildings follow the ground once a stroke is over, not on every dab of it
      if (groundSettled && groundChanges.version !== buildingGroundSeen) {
        const moved = buildingGroundSeen < 0 ? null : buildingsOnGroundSince(net.doc, buildingGroundSeen);
        if (moved === null || moved.length > 0) buildingGround = String(groundChanges.version);
        buildingGroundSeen = groundChanges.version;
      }
      // At the opening the buildings come once the first world (the roads, the ground cut and filled to them) is in
      if (roads !== null && (reveal.opened || !worldJob)) {
        buildings.hidden = !reveal.opened;
        buildingsGrounded = true;
        farRoads.coarseFirst(buildings.hidden);
        nearTiles.coarseFirst(buildings.hidden);
        // Buildings put together or streamed in (HLOD, `layer.ts`) are new casters: the shadow map is drawn again.
        settleNearTiles();
        if (buildings.update(net.doc, terrain.renderedHeightAt, buildingGround, pavedHeightAt, builtGroundAt,
          (since) => (since === '' ? null : buildingsOnGroundSince(net.doc, Number(since))))) shadowMoved = true;
        // Another frame while they land, nothing more: what lands stirs the stores itself (childadded, the door, `update`'s answer).
        if (buildings.pending) askDraw();
      }
      // The countryside's trees' kit (its models, its programs compiled ahead: `loadNatureTrees`) made while the first world is built, not after: it reads nothing of the world, and the opening waited for it once the world was in (`natureTreesPending`, the curtain's `whole`). The trees themselves are grown once the world stands (the nature's keeps, `!worldJob`).
      if (!natureTreesStarted && roads !== null) startNatureTrees();
      // The Actions' effects (`playEffects.ts`) made in idle time once the world stands, not on the first shot
      if (!fxPreload && !fxLoading && roads !== null && !worldJob && typeof requestIdleCallback === 'function') {
        fxPreload = true;
        requestIdleCallback(() => { void loadEffects(); }, { timeout: 5000 });
      }
      // Each building's plants (`gardenLists.ts`), placed again only when some changed.
      const plants = plantLists.update(net.doc.buildings, groundSettled);
      if (plants) {
        // Kept building by building (`gardens.ts`): a list the same as before keeps its plants' slots.
        gardens ??= createGardens(sceneryKit);
        const swapped = gardens.update(plants);
        for (const mesh of swapped.removed) world.remove(mesh);
        for (const mesh of swapped.added) world.add(mesh);
      }
      // THE PLANTS AND STONES (`coverSweep.ts`/`coverKeeps`, `natureSweep`/`natureKeeps`, the planted trees)
      if (!stroking && !worldJob) {
        keepNet = net;
        // What the tests read that changed since the last look, and where (null: the diary cannot say).
        const entries = vegetationRead.read(net.doc.changes);
        let rects: ChangeRect[] | null = entries === null ? null : [];
        for (const entry of entries ?? []) {
          if (entry.rects === null) { rects = null; break; }
          rects!.push(...entry.rects);
        }
        // The stones, the scrub and the painted woods: swept again only in the cells the paint reached (`coverSweep.ts`).
        {
          const at = performance.now();
          const paint = activeTiles.read(coverPaintRead, net.doc.changes);
          // A streamed world's painted cover is the tiles' (`coverTiles.ts`, baked in workers): the region sweeps none; the rivers' stones stay the plates'.
          if (activeAt !== null) {
            if (!coverTiled) { coverTiled = true; for (const keep of [coverKeeps.forest, coverKeeps.scrub, coverKeeps.rocks]) keep.clear(); }
          } else if (paint === null || paint.some((e) => e.rects === null) || coverTiled) { coverTiled = false; sweepAllCovers(net.doc); }
          else if (paint.length) {
            const cells = new Set<number>();
            for (const e of paint) for (const r of e.rects!) keepCellsOver(r, COVER_SWEEP_PAD, cells);
            resweepCovers(cells);
          }
          shorePlates.follow(terrain.parts);
          measureHitch('hitch:cover/sweep', at);
        }
        // The painted woods' trees are the countryside's (`natureTrees.ts`); the old card trees only if those cannot be grown.
        const standIns = !natureTreeKit && !natureTreesPending;
        let coverWhole = vegetationRedraw || coverStandIns !== standIns;
        // The cells whose places changed, of every kind (the painted woods' are read by the cover's card trees and by the forest).
        const changed = new Set<number>();
        // The stones take the colour of the painted rock under them: drawn again where the geology changed.
        const geology = terrain.geologyChanges.version;
        if (geology !== coverGeologySeen) {
          const painted = coverGeologySeen < 0 ? null : terrain.geologyChanges.rectsSince(coverGeologySeen);
          if (painted === null) coverWhole = true;
          else for (const r of painted) keepCellsOver(r, TERRAIN_CELL, changed);
          coverGeologySeen = geology;
        }
        {
          const at = performance.now();
          if (rects === null) for (const keep of coverKinds) keep.refreshAll();
          else if (rects.length) for (const keep of coverKinds) keep.refresh(rects, KEEP_REACH);
          for (const keep of coverKinds) {
            const cells = keep.takeChangedCells();
            if (cells === null) coverWhole = true; else for (const cell of cells) changed.add(cell);
          }
          if (coverWhole || changed.size) {
            // DO NOT gather every cell of the map unless every cell is drawn again.
            coverCellsOf().sync(coverWhole ? null : changed, coverWhole ? allCoverCells() : []);
            paintedForestOf()?.sync(coverWhole ? null : changed, coverWhole ? coverKeeps.forest.cellKeys() : []);
          }
          coverStandIns = standIns;
          measureHitch('hitch:cover', at);
        }
        // The ecosystem's own trees.
        bringPlateLand(net.doc);
        const natureSweepKey = `${ecologySeen.follow(terrain.parts)}:${landSerial}:${quality.vegetation}`;
        if (natureSweepWant !== natureSweepKey || natureSweepPending) {
          const at = performance.now();
          natureSweepWant = natureSweepKey;
          const swept = natureSweep(natureSweepKey);
          natureSweepPending = (swept.pending ?? 0) > 0;
          // While plates wait their sweep (one a frame), the trees standing stay
          if (!natureSweepPending || !natureSweepState) natureSweepState = swept;
          measureHitch('hitch:nature/sweep', at);
        }
        if (natureSweepState) {
          const sweep = natureSweepState;
          const at = performance.now();
          // A new sweep fills again the cells of the plates swept again only (`fileNature`).
          if (natureFiledFrom !== sweep) {
            natureFiledFrom = sweep;
            fileNature(sweep);
          }
          if (rects === null) natureKeeps.refreshAll();
          else if (rects.length) natureKeeps.refresh(rects, KEEP_REACH);
          const cells = natureKeeps.takeChangedCells();
          const whole = cells === null || vegetationRedraw;
          if (whole || cells!.size) {
            const changed = whole ? null : cells;
            if (natureTreeKit) {
              natureForest ??= (() => {
                const made = createTreeCells(natureTreeKit, 'nature-forest', (cell) => natureKeeps.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
                world.add(made.group);
                return made;
              })();
              natureForest.sync(changed, whole ? natureKeeps.cellKeys() : []);
              // Grown (or nothing to grow): no longer drawing while waiting for them.
              natureTreesPending = false;
            }
            // The old card trees only if the new ones could not be grown
            natureCards ??= (() => {
              const made = createCoverCells(coverKit, 'nature-cards', {
                rocksIn: () => [], scrubIn: () => [],
                treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? natureKeeps.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
              });
              world.add(made.group);
              return made;
            })();
            natureCards.sync(changed, whole ? natureKeeps.cellKeys() : []);
          }
          measureHitch('hitch:nature', at);
        }
        // The trees the player planted (`world/trees.ts`), with the woods' own models: filed again only in the cells planted or cut
        // A streamed world's planted trees are the tiles' (`plantedTiles.ts`, baked in workers) once a tile's bake landed; until then the region draws its own tiles' (`plantedByTile`).
        if (natureTreeKit) {
          const planted = activeTiles.read(plantedRead, net.doc.changes);
          if (planted === null || planted.some((e) => e.rects === null)) { plantAll(net.doc); plantedFlips.clear(); }
          else if (planted.length || plantedFlips.size) {
            const cells = new Set<number>();
            for (const e of planted) for (const r of e.rects!) keepCellsOver(r, 0, cells);
            // A tile whose bake came or went: its cells filed again, its trees let go or taken back.
            for (const tile of plantedFlips) { const { i, j } = tileOfKey(tile); keepCellsOver([i * TILE, j * TILE, (i + 1) * TILE - 1e-6, (j + 1) * TILE - 1e-6], 0, cells); }
            plantedFlips.clear();
            for (const key of cells) plantedKeeps.fill(key, plantedIn(net.doc, key), (a, b) => a === b);
          }
          if (rects === null) plantedKeeps.refreshAll();
          else if (rects.length) plantedKeeps.refresh(rects, KEEP_REACH);
          const cells = plantedKeeps.takeChangedCells();
          if (cells === null || cells.size || vegetationRedraw) {
            const forest = plantedForestOf()!;
            const whole = cells === null || vegetationRedraw;
            forest.sync(whole ? null : cells, whole ? plantedKeeps.cellKeys() : []);
          }
        }
        vegetationRedraw = false;
      }
      // The perspective camera kept out of the buildings (`IsoRig.setSolids`)
      followFloors(net);
      if (cameraSolidsKept.follow(net.doc.buildings, floorGroundSince)) {
        rig.setSolids((x, y) => cameraSolidsKept.solids().floorAt(x, y), (x, y) => cameraSolidsKept.solids().roofAt(x, y));
        townSolids = () => cameraSolidsKept.solids();
      }
      // The light the buildings shut out of the streets round the view (`canyonLight.ts`).
      post.followTown(rig.target.x, -rig.target.z, townSolids, canyonChanges(net.doc.changes));
      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      const plantMap = rig.viewport.zoom < PLANT_MAP_ZOOM;
      // The buildings' detail and parts by the error on the screen (`levelOfDetail`, `cullDetails`).
      {
        const eye = rig.camera.position;
        let k = 1;
        if (!rig.perspective) {
          const halfH = css.h / Math.max(1e-3, 2 * rig.viewport.zoom);
          k = halfH / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360) / Math.max(1e-3, eye.distanceTo(rig.target));
        }
        const t = rig.target;
        const ex = t.x + (eye.x - t.x) * k, ey = -(t.z + (eye.z - t.z) * k), ez = t.y + (eye.y - t.y) * k;
        // The far level of the buildings by the error on the screen, in CSS pixels
        const pxAtMetre = css.h / (2 * Math.tan(((rig.perspective ? (rig.camera as PerspectiveCamera).fov : PERSPECTIVE_FOV) * Math.PI) / 360));
        // In the view from above a metre spans the same pixels wherever it stands; in perspective nothing past the far plane is seen
        let reach = rig.perspective ? (rig.camera as PerspectiveCamera).far : Infinity;
        if (!rig.perspective) {
          const halfH = css.h / Math.max(1e-3, 2 * rig.viewport.zoom);
          const halfW = (halfH * css.w) / Math.max(1, css.h);
          reach = Math.hypot(halfW, halfH / Math.max(0.3, Math.sin(rig.viewport.elevation))) * 1.25 + m(120);
        }
        rig.camera.updateMatrixWorld();
        detailProjection.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
        detailFrustum.setFromProjectionMatrix(detailProjection, rig.camera.coordinateSystem, rig.camera.reversedDepth);
        // The sun's cascades are made by three at their first draw: counted as they stand before the detail is chosen.
        gpuLedger.set('shadow maps', 'shadow maps', renderTargetsBytes(environment.shadowMaps()));
        // The view's budget of triangles (`core/perfBudget.ts`): the levels' error scale rises until they fit (`buildings/frameBudget.ts`).
        buildings.frame.budget = VIEW_BUDGETS[viewOf(rig.viewport.zoom)].triangles;
        buildings.levelOfDetail(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach, detailFrustum);
        farRoads.choose(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach, detailFrustum);
        nearTiles.choose(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach, detailFrustum);
        // DO NOT leave a road just built invisible until its tile's near roads come back (over 2 s, the player): drawn now from the network the commit solved, let go once its tile's edit is drawn or no near roads are wanted there (`farTree.ts` standInDone).
        for (const tile of roadStandIn.settled()) if (farRoads.standInDone(tile)) roadStandIn.drop(tile);
        roadStandIn.settle();
        if (pendingStandIn.length && elevation && net.revision === net.doc.revision) {
          // Drawn by tiles: let go by each tile's near roads; drawn whole by the page (a map of its own): by the build of the commit's revision landing, every commit not landed yet standing.
          roadStandIn.show(net, elevation, pendingStandIn.splice(0), activeAt === null ? net.revision : undefined);
        }
        roadStandIn.landed(landedRevision);
        // A shadow texel's side, m: a part's shadow narrower than it is not cast.
        const shadow = environment.sun.shadow;
        const texel = environment.sun.castShadow ? (shadow.camera.right - shadow.camera.left) / shadow.camera.zoom / shadow.mapSize.x : Infinity;
        buildings.cullDetails(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, texel);
      }
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      watchRoads(net);
      // DO NOT test `-leaves`: no mesh is named so, and the cards were drawn at every zoom.
      for (const mesh of furniture.meshes) {
        mesh.visible = quality.detailProps && detailed && (!plantMap || !isLeafCards(mesh));
      }
      for (const mesh of gardens?.meshes ?? []) {
        mesh.visible = detailed && (!plantMap || !isLeafCards(mesh));
      }
      gardens?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      // After `visible` is set (the contract of `Scenery.setMap`), and only when the map zoom is crossed or the layer is new
      if (plantMap !== plantMapFor.map || gardens !== plantMapFor.gardens) {
        plantMapFor = { map: plantMap, gardens };
        gardens?.setMap(plantMap);
        furniture.setMap(plantMap);
      }
      // The roads just laid: a strip over their whole width, on their own deck.
      if (pendingRoadFlash.length && elevation) {
        const pos: number[] = [], ring: number[] = [];
        for (const id of pendingRoadFlash.splice(0)) {
          const ribbon = net.ribbons.get(id);
          if (!ribbon) continue;
          const line = ribbon.full, half = sidewalkHalf(ribbon.road);
          const at = (s: number, side: number): [number, number, number] => {
            const f = line.sampleAt(Math.min(s, line.length));
            const x = f.p.x + f.n.x * half * side, y = f.p.y + f.n.y * half * side;
            return [x, elevation!.onSegment(id, f.p.x, f.p.y) + m(0.3), -y];
          };
          // The road itself only: cut where its ends meet a junction (its trims), not running into the road it joins.
          const trims = net.trims.get(id);
          const from = trims ? Math.max(0, ...Object.values(trims.a)) : 0;
          const to = line.length - (trims ? Math.max(0, ...Object.values(trims.b)) : 0);
          const step = m(1.5);
          for (let s = from; s < to; s += step) {
            const e = Math.min(to, s + step);
            const l0 = at(s, 1), r0 = at(s, -1), l1 = at(e, 1), r1 = at(e, -1);
            pos.push(...l0, ...r0, ...r1, ...l0, ...r1, ...l1);
            for (let k = 0; k < 6; k++) ring.push(0);
          }
        }
        if (pos.length) addBlink(pos, ring);
      }
      for (let i = gridFlashes.length - 1; i >= 0; i--) {
        const f = gridFlashes[i]!;
        const t = (performance.now() - f.start) / 1000;
        f.time = t;
        if (t > f.end) { scene.remove(f.mesh); f.mesh.geometry.dispose(); gridFlashes.splice(i, 1); }
        else onAssetsReady();
      }
      // DO NOT hide the sky behind a plain dark blue: past the map's edge and over the horizon the player saw a navy void at noon (playtest 02b/22-turned, 2026-10-18); the sky (`environment.ts`) follows the hour.
      // The wind blows in real time: a paused simulation is still a windy day.
      windClock += Math.min(0.1, Math.max(0, delta));
      advanceWind(windClock);

      const cullCamera = rig.camera;
      crowdProjection.multiplyMatrices(cullCamera.projectionMatrix, cullCamera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection, cullCamera.coordinateSystem, cullCamera.reversedDepth);
      cameraRight.setFromMatrixColumn(cullCamera.matrixWorld, 0).normalize();
      // The canvas's CSS size read once a frame, before the vehicles ask `screenScale`
      cssHalfW = css.w * 0.5;
      cssHalfH = css.h * 0.5;
      // Plants and street furniture outside the view are not drawn at all.
      // The layers' shadow margin away from the sun the cascades cast by. DO NOT take the light's position less its target: both move with every fit of the cascades (the ground coming in, the camera), their difference by the last bits, and every layer's every kind was culled again each frame the view stood still.
      setShadowSun(environment.toSun.x, environment.toSun.y, environment.toSun.z);
      furniture.cull(crowdFrustum, crowdProjection);
      signs.cull(crowdFrustum, crowdProjection);
      barriers.cull(crowdFrustum, crowdProjection);
      transit.cull(crowdFrustum, crowdProjection);
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.cull(crowdFrustum, crowdProjection);
      elementLayer?.cull(crowdFrustum, crowdProjection);
      gardens?.cull(crowdFrustum, crowdProjection);
      transit.update(sim.trains, terrain.renderedHeightAt);
      frustumGroundBox(crowdFrustum, VEHICLE_REACH, VEHICLE_LOW, VEHICLE_HIGH, vehicleBox);
      agents.sync(sim, net, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        personPixels,
        screenScale,
        pixelRatio: renderer.getPixelRatio(),
        shadows: renderer.shadowMap.enabled,
        eye: cullCamera.position,
        vehicleVisible,
        vehicleInside,
        vehicleBox,
        occupantZoom: quality.occupantZoom,
        // The tier's lighter vehicles and people (`quality.ts`; only the low tier draws them lighter).
        tier: quality,
        exhaust: (x, y, z, angle, length, speed, dusty) => {
          exhaust.emit(x, y, z, angle, length, speed, dusty);
          if (!dusty && Math.abs(speed) > 0.5) wear.wheels(x, y, angle, Math.min(length * 0.42, m(1.7)), wallDt);
        },
        // The bodies of shots and blows (`playEffects.ts`), once anybody has shot or struck.
        ...(fx ? { ragdolls: (citizens: Parameters<PlayEffects['frame']>[0]) => fx!.frame(citizens, sim, wallDt, fxDt) } : {}),
        hiddenPed: (id) => fx?.hides(id) ?? false,
      });
      // The micro window follows the view's centre; the far cars of the meso step drawn round it.
      densityCars.update(net, sim, rig.target.x, -rig.target.z);
      exhaust.tick(windClock, renderer.domElement.height / 2);
      fx?.update(wallDt, fxDt);
      for (const ped of sim.pedViews) if (ped.v > 0.05) wear.feet(ped.x, ped.y, wallDt);
      wear.follow(rig.viewport.centre.x, rig.viewport.centre.y);
      wear.tick(wallDt);
      // The rooms cut open are lit from inside: brighter as the day goes.
      const key = cutSpec ? `${cutSpec.level}@${cutSpec.x},${cutSpec.y}:${net.doc.buildings.revision}` : '';
      if (key !== lampsKey) {
        lampsKey = key;
        const lamps = roomLamps.lamps(net.doc, cutSpec, builtGroundAt, pavedHeightAt, ROOM_LIGHTS);
        roomLights.forEach((light, i) => {
          const at = lamps[i];
          light.userData['used'] = !!at;
          if (at) light.position.set(at.x, at.z, -at.y);
        });
      }
      // Falls off with the distance in world units: the same lamp in metres at any unit.
      for (const light of roomLights) light.intensity = cutSpec && light.userData['used'] ? 55 * TUNED_UNIT ** light.decay * (0.25 + 0.75 * lastDark) : 0;
      signals.sync(sim.signals, net, detailed, crowdFrustum);

      target.copy(rig.target);
      const halfHeight = css.h / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * css.w) / Math.max(1, css.h);
      // The screen's height covers more ground the lower the camera looks
      const reach = rig.perspective ? 1.6 : 1;
      const groundHalfDepth = (reach * halfHeight) / Math.max(0.3, Math.sin(rig.viewport.elevation));
      // The top of the tallest building, as the layer keeps it (`BuildingLayer.top`).
      const tallestTop = Math.max(0, buildings.top);
      // Day and night, by the city's clock (`sim/city/city.ts`).
      const fixedHour = skyMode === 'day' ? 16 * 60 : skyMode === 'night' ? 22 * 60 : null;
      const clock = fixedHour === null ? sim.minutes : fixedHour;
      {
        // THE WEATHER (`world/weather.ts`): the wind carries the clouds and bends the plants and the smoke
        const weather = net.doc.weather;
        const step = Math.min(0.1, Math.max(0, delta));
        const wind = windVector(weather, m(1));
        cloudDrift.x += wind.x * step;
        cloudDrift.y += wind.y * step;
        post.setCloudDrift(cloudDrift.x, cloudDrift.y);
        setWindWeather(wind.x, -wind.y, weather.wind);
        // The water: its waves run with the wind, rougher the harder it blows; its foam; how fast the rivers run.
        const windLength = Math.hypot(wind.x, wind.y);
        const angle = (weather.windDirection * Math.PI) / 180;
        terrain.setWaterLook({
          waves: Math.min(1, weather.waves + weather.wind / 40),
          foam: weather.foam,
          current: weather.current * m(1),
          windX: windLength > 1e-6 ? wind.x / windLength : Math.cos(angle),
          windZ: windLength > 1e-6 ? -wind.y / windLength : -Math.sin(angle),
          windSpeed: windLength,
        });
        const span = 2 * Math.max(halfWidth, halfHeight);
        if (weather.lightning > 0 && Math.random() < (step * weather.lightning) / 60) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * span * 0.45;
          strikeAt(target.x + Math.cos(a) * r, -target.z + Math.sin(a) * r);
        }
        canvasSize.set(css.w, css.h);
        const flash = lightning.update(step, canvasSize);
        const storm = Math.min(1, weather.lightning / 8);
        environment.setWeather(Math.max(weather.rain * 0.85, storm * 0.6), flash);
        rainWind.set(wind.x, -wind.y);
        rain.update(weather.rain, target, span, rainWind, step);
        sceneryKit.setHaze(Math.max(weather.rain, storm));
        weatherActive = weather.rain > 0 || weather.lightning > 0 || flash > 0 || (weather.wind > 0 && placedCloudsShown);
      }
      const dark = environment.setTimeOfDay(clock);
      // What a cloud's shadow can take: the sun's share of the light now.
      post.setDirectShare(environment.directShare());
      if (Math.abs(dark - lastDark) > 0.01) {
        lastDark = dark;
        post.setNight(dark);
        sceneryKit.setNight(dark);
        agents.setNight(dark);
      }
      // The windows every frame: how many rooms are lit follows the clock
      buildings.setNight(lastDark, clock / 60);
      // The sun's cascades fitted to what the camera sees, up to the tallest top.
      environment.follow(rig.camera, target, tallestTop, builtGroundAt);
      // What the simulation must show in full: people step round each other only where they are seen, and big enough to see it
      {
        // In perspective, tilted towards the horizon, the camera sees far past the circle round the centre of the view
        let view: { ex: number; ey: number; dx: number; dy: number; cos: number; far: number } | null = null;
        if (rig.perspective) {
          // The cone on the plane, as the simulation sees it.
          const coneDirection = rig.camera.getWorldDirection(flatDirection);
          const flat = Math.hypot(coneDirection.x, coneDirection.z);
          if (flat > 0.05) {
            const aspect = css.w / Math.max(1, css.h);
            const fov = rig.camera instanceof PerspectiveCamera ? rig.camera.fov : PERSPECTIVE_FOV;
            const halfAcross = Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
            view = {
              ex: rig.camera.position.x, ey: -rig.camera.position.z,
              dx: coneDirection.x / flat, dy: -coneDirection.z / flat,
              cos: Math.cos(Math.min(Math.PI, halfAcross + VIEW_MARGIN)), far: VIEW_SEEN,
            };
          }
        }
        sim.focus = {
          x: target.x,
          y: -target.z,
          r: Math.hypot(halfWidth, groundHalfDepth) + m(20),
          detail: rig.viewport.zoom * m(1.7) >= 10,
          view,
        };
      }

      // The shadow pass, drawn when the map can have changed.
      if (renderer.shadowMap.enabled) {
        // The two-wheelers changed between casting and a soft disc: their shadows come or go now.
        if (agents.castersChanged) shadowMoved = true;
        // Moving only when something that moves is in the pass (`movingCasters`) or the wind bends the trees
        simRunning = !sim.paused;
        const moving = net.doc.weather.wind > 0 || (simRunning && movingCasters());
        if (castersMoved && !moving) shadowMoved = true;
        castersMoved = moving;
        // Each cascade drawn when what it holds can have changed (`sunCascades.ts` `pass`)
        // The still casters as they stood at the last pass: the same view (what the layers cull by it) and nothing landed, added or taken away since.
        const viewStill = shadowView.equals(rig.camera.matrixWorld) && shadowProjection.equals(rig.camera.projectionMatrix);
        shadowView.copy(rig.camera.matrixWorld);
        shadowProjection.copy(rig.camera.projectionMatrix);
        // The buildings' levels follow the frame's error scale too (`frameBudget.ts`): one moved, other levels cast.
        const scaleStill = shadowScale === buildings.frame.scale;
        shadowScale = buildings.frame.scale;
        const still = viewStill && scaleStill && !castersStirred;
        castersStirred = false;
        if (environment.shadowPass({ changed: shadowMoved, effects: simRunning && (fx?.busy() ?? false), still })) {
          renderer.shadowMap.needsUpdate = true;
        }
        shadowMoved = false;
      }
      // An explosion shakes the camera for a moment.
      const shake = fx?.shake() ?? 0;
      if (shake > 0) {
        shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
        rig.camera.position.add(shakeOffset);
        rig.camera.updateMatrixWorld();
      }
      // The land's own light (its hills' shading, baked a plate at a time).
      terrain.setSun(sunTowards.copy(environment.sun.position).sub(environment.sun.target.position));
      {
        // The relief's close window (terrainRelief.ts) round the ground the view looks at, drawn a little towards the camera
        const centre = rig.viewport.centre;
        const cam = rig.camera.position;
        const dx = cam.x - centre.x, dz = cam.z + centre.y;
        const across = Math.hypot(dx, dz);
        const pull = across > 1 ? Math.min(150, across * 0.3) / across : 0;
        reliefFocus.x = centre.x + dx * pull;
        reliefFocus.z = -centre.y + dz * pull;
        // Close: the screen's height under some 1800 units of ground, in either camera
        const halfHeight = css.h / Math.max(1e-3, 2 * rig.viewport.zoom);
        const close = halfHeight < 900;
        if (net.doc.gullyRevision !== gulliesFor) {
          gulliesFor = net.doc.gullyRevision;
          terrain.setGullies(net.doc.gullyDabs, net.doc.gullyAuto);
        }
        // The atlas keeps in full only the plates near what the view takes in (`flatAtlas.ts`).
        terrain.focus?.(centre.x, centre.y, halfHeight);
        // Each plate's patches for this camera, where a coarser level would move the ground by under a pixel (`terrainLod.ts`).
        terrain.lookFrom?.(rig.camera, renderer.domElement.height);
        // The roads at full detail within reach of what the view takes in, the far level beyond: a few frames apart
        roadFocus.x = centre.x; roadFocus.y = centre.y;
        // Shortened by the frame's error scale: a frame that cannot afford the buildings' detail cannot afford the roads' either.
        roadFocus.reach = Math.min(900, Math.max(320, halfHeight * 1.8)) / buildings.frame.scale;
        if (roadFocus.frames++ % 6 === 0) {
          const blocks: Mesh[] = [];
          for (const { mesh } of surfaceReuse.chunks.values()) blocks.push(mesh);
          updateRoadLevels(blocks, roadFocus.x, roadFocus.y, roadFocus.reach);
        }
        terrain.bakeRelief(renderer, close ? reliefFocus : null);
      }
      {
        // The painted fog: its map again when the fog or the land under it changed (never in the middle of a sculpting stroke).
        const doc = net.doc;
        // A fog stroke shows as it is painted; a land stroke waits for its end.
        const landHeld = !!options?.holdRoads && fogTerrainSeen !== doc.terrainRevision;
        const fogSerial = doc.changes.serialOf(...FOG_KINDS);
        if ((fogJournal !== doc.changes || fogSerial !== fogSeen) && !landHeld) {
          const startedAt = performance.now();
          // Only where the fog, the land or the ground under it changed (`createFogField`)
          const entries = fogJournal === doc.changes && fogSeen >= 0 ? doc.changes.since(fogSeen, FOG_KINDS) : null;
          const ground = (x: number, y: number): number => terrain.renderedHeightAt(x, y);
          const laid = !entries || entries.some((e) => e.rects === null)
            ? fogField.whole(doc.fogDabs, ground)
            : fogField.update(doc.fogDabs, ground, entries.flatMap((e) => e.rects!));
          fogLayer = laid.any ? laid : null;
          fogJournal = doc.changes;
          fogSeen = fogSerial;
          fogTerrainSeen = doc.terrainRevision;
          measureHitch('hitch:fog', startedAt);
        }
        if (!landHeld) {
          // The fog's window kept round where the view looks (`fogLayer.ts`): only the texels that came in written.
          const followed = fogField.follow(rig.viewport.centre.x, rig.viewport.centre.y, doc.fogDabs, (x, y) => terrain.renderedHeightAt(x, y));
          if (followed) fogLayer = followed.any ? followed : null;
        }
        const f = doc.fogSettings;
        post.setPlacedClouds(doc.clouds);
        // The elements: again only in the cells where they or the ground under them changed (`elements.ts`).
        if (elementKit && !landHeld) {
          const startedAt = performance.now();
          const layer = elementLayerOf()!;
          // A streamed world's elements are the tiles' (`elementTiles.ts`, baked in workers): the region makes none.
          layer.setTiled(activeAt !== null);
          const entries = activeTiles.read(elementRead, doc.changes);
          let cells: Set<number> | null = null;
          if (entries !== null && entries.every((e) => e.rects !== null)) {
            cells = new Set();
            // A prop stands on the ground drawn under its point: a terrain cell round a change of the ground.
            for (const e of entries) for (const r of e.rects!) keepCellsOver(r, TERRAIN_CELL, cells);
          }
          if ((cells === null || cells.size > 0) && layer.sync(cells, doc, (x, y) => terrain.renderedHeightAt(x, y))) {
            layer.cull(crowdFrustum, crowdProjection);
            shadowMoved = true;
          }
          measureHitch('hitch:elements', startedAt);
        }
        elementLayer?.emit(Math.min(0.1, Math.max(0, delta)), rig.camera.position, exhaust);
        post.setGroundFog(fogLayer?.any ? { texture: fogLayer.texture, low: fogLayer.low, high: fogLayer.high, density: f.density, window: fogLayer.window } : null);
        fogMoving = !!fogLayer?.any;
        placedCloudsShown = doc.clouds.length > 0 || !!elementLayer?.hasEffects;
      }
      // Rain thickens the air: a grey mist over the distance (`world/weather.ts`).
      const rainNow = net.doc.weather.rain;
      const air = rainNow > 0 ? { ...atmosphere, fog: Math.max(atmosphere.fog, rainNow * 0.2), fogHeight: Math.max(atmosphere.fogHeight, m(120)) } : atmosphere;
      // The orthographic camera stands far back by construction
      const eyeShift = rig.perspective ? 0
        : rig.camera.position.distanceTo(rig.target) - halfHeight / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
      post.setAtmosphere(air, sunTowards.copy(environment.sun.position).sub(environment.sun.target.position), environment.skyColor,
        sunLight.copy(environment.sun.color).multiplyScalar(environment.sun.intensity), eyeShift);
      const atRender = performance.now();
      // The people's skeletons on the GPU (`people/crowdAnimation.ts`), before anybody draws them.
      agents.renderPalettes(renderer);
      {
        // DO NOT keep the eight point lights in the scene unlit (R18): three counts every visible light and each lit fragment evaluates it; shown together, so they make one variant (compiled ahead, `lightVariants`).
        const pointsOn = fxLights.muzzle.intensity > 0 || fxLights.blast.intensity > 0 || roomLights.some((light) => light.intensity > 0);
        for (const light of roomLights) light.visible = pointsOn;
        fxLights.muzzle.visible = fxLights.blast.visible = pointsOn;
      }
      // The world matrices of what moves, once for every pass of the frame.
      updateMoving(scene);
      // Every texture queued this frame to the GPU before anything draws with it (R19).
      drainUploads(renderer);
      // The opening's town is shown whole
      openingSince ??= performance.now();
      if (!reveal.opened) {
        // THE OPENING IN TWO STEPS (CLAUDE.md "Streaming world"): shown once the roads built so far, the masses and the far levels are in; the near cells' detail, the tiles still coming and the world's later builds land after, as they do when the camera moves (DO NOT wait for `buildings.pending`, `worldJob` or every tile of the region: the whole city waited 2.5-4.5 min for them, 2026-10-16).
        const held = openingHeld?.() ?? true;
        // OPEN = WHAT THE VIEW SEES IN ITS FINAL DETAIL (CLAUDE.md; Cesium3DTileset tilesLoaded: every tile meeting the screen's error this frame loaded): the near cells, the near roads and the tiles' near products in the frustum too, not the masses alone - the curtain fell with the district in masses and the street in a smooth mass (conf130/131/133).
        const whole = roads !== null && !buildings.coarsePending && !buildings.viewPending && farRoads.waiting === 0 && nearTiles.pendingInView() === 0 && natureTreesStarted && !natureTreesPending && held;
        // DO NOT draw the unseen frame before the town's programs are built: drawn first, each program was built at its first use, one after the other, in that one frame (4.5 s of the opening's 62, 2026-10-16); asked together, the driver builds them in parallel (KHR_parallel_shader_compile).
        if (whole && openingPrograms === 'no') {
          openingPrograms = 'asked';
          programs.compile(scene);
          const ready = programs.ready;
          void ready.then(() => { if (programs.ready === ready) { openingPrograms = 'built'; onAssetsReady(); } });
        }
        const next = reveal.step(whole && openingPrograms === 'built', performance.now(), !held);
        if (next === 'warm') {
          // One frame drawn unseen first, its programs built: the new meshes go to the GPU
          if (post.target) {
            renderer.setRenderTarget(post.target);
            renderer.render(scene, rig.camera);
            renderer.setRenderTarget(null);
          }
          programs.compile(scene);
          onAssetsReady();
        } else if (next === 'show') {
          // Shown however far it got (`REVEAL_LIMIT_MS`): its programs compiled all the same.
          programs.compile(scene);
          performance.mark('opening:shown', { detail: { waitedMs: performance.now() - openingSince, workedMs: reveal.worked, whole } });
        }
      }
      if (reveal.opened) {
        // Round the frame's whole drawing: the shadow, the scene, every pass.
        gpuTimer.poll();
        gpuTimer.begin();
        post.render(delta);
        gpuTimer.end();
        governFrame();
      } else onAssetsReady();
      measureHitch('hitch:draw/Render', atRender);
      if (shake > 0) { rig.camera.position.sub(shakeOffset); rig.camera.updateMatrixWorld(); }
      // And those queued while the frame drew: on the GPU before the next one draws.
      drainUploads(renderer);
      drainCompiles(renderer, rig.camera, scene, post.target);
      // From the second frame on, the compiler answers: warm the road shaders.
      warmRoadShaders();
      warmBlastShaders();
      warmPreviewShaders();
      // One waiting body's geometry a frame to the GPU, before anybody draws it.
      drainWarm(renderer);
      // Meshes still waiting to go up: another frame, so the queue never stands while the game is still (DO NOT stir the stores for it: a mesh is a caster once through the door, which says so).
      if (warmPending()) askDraw();

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
    },
    setQuality(level, settings) {
      requested = level;
      const resolved = level === 'auto' ? governor.current : level;
      governor.set(resolved);
      applyQuality(resolved, settings);
    },
    get quality() {
      return requested;
    },
    dispose() {
      sizeWatch?.disconnect();
      roadTiles.dispose();
      groundWorkers.dispose();
      tileWriter?.terminate();
      // Everything the renderer made, the GPU's included: the layers, the previews and the effects too
      fx?.dispose();
      densityCars.dispose();
      exhaust.dispose();
      wear.dispose();
      // The tiles' products first: they take their runs back from the layers below.
      nearTiles.dispose();
      barriers.dispose();
      transit.dispose();
      transitPreview?.dispose();
      polePreview?.dispose();
      utilities?.dispose();
      signs.dispose();
      for (const flash of gridFlashes) flash.mesh.geometry.dispose();
      agents.dispose();
      signals.dispose();
      buildings.dispose();
      farRoads.dispose();
      blinkMaterial.dispose();
      worldJob = null;
      roads?.dispose();
      disposeSurfaceReuse(surfaceReuse);
      details?.dispose();
      furniture.dispose();
      gardens?.dispose();
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.dispose();
      coverKit.dispose();
      fogTexture.dispose();
      elementLayer?.dispose();
      elementKit?.dispose();
      paintedForest?.dispose();
      plantedForest?.dispose();
      rain.dispose();
      lightning.dispose();
      natureTreeKit?.dispose();
      sceneryKit.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      lotOverlay?.dispose();
      renderer.dispose();
    },
  };
  return handle;
}
