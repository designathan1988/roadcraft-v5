import { gaitSpeed, type BodyPart, type PersonAgeClass, type Severable } from '@sim/people/view';
import { simplified } from './mesh/simplify';
import {
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type WebGLRenderer,
} from 'three';

import { framesPoseInto, newPose, pedPoseInto } from '@sim/pose';
import { roadFrameInto } from './vehicleFrame';
import {
  ARCHETYPES,
  archetypeById,
  type Archetype,
  type VehicleShape,
} from '@sim/vehicles/archetypes';
import type { SimClient, VehicleView as SimVehicle } from '@sim/host/simClient';
import type { FleetCell, GroundBox } from '@sim/host/fleetGrid';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import type { ChangeKind } from '@world/changes';
import { ChangeSweep } from '@world/derived';
import { m, perM } from '@world/units';
import { hypot2 } from '@core/scalar';
import { DT, FLEET_CEILING, PED_CEILING } from '@sim/params';
import { STAGGER_FROM, STAGGER_TIME, staggerSpeed } from '@sim/agents/walk';
import { buildCarModel, carStyleOf, carStylesFor } from './carBody';
import { CROWD_IDS, createRiggedCitizens, type CitizenClipKey, type ClipIdentity } from './riggedCitizens';
import { createProceduralCrowd, type ProcClip, type ProceduralPerson } from './people/proceduralCrowd';
import { randomPerson } from '@people/spec';
import { ageFromYears } from '@people/body/macro';
import { PLAYER_ID } from '@sim/ambient/playerId';
import type { RagdollCitizens } from './ragdoll';
import type { Company } from './citizenCasting';
import { kerbTransfer, seatPerson, type KerbStop } from '@sim/vehicles/kerbStops';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { walkingRise } from '@world/curbRamps';
import { groundGradient } from './groundShear';
import { blinkOn, steerFrom } from '@sim/vehicleSignals';
import {
  axleStations, buildBusModel, buildTruckModel, buildTwoWheelerModel, seatFitScale, rimGeometry, spokedRimGeometry,
  merge, tyreGeometry, type TwoWheelerModel, type VehicleModel,
} from './vehicleModels';
import { HELMET_SEGMENTS, STEER_FULL } from './riderPoses';
import { NIGHT_LUMINANCE, nightGain } from './lightLevels';
import { DOOR_SWING, createKerbFigure, kerbFigure, occupantPlays, type Play } from './occupants';
import { blobInto, blobMesh } from './blobShadows';
import { ERROR_PIXELS, LEVELS, LEVEL_ERRORS, levelFor, partLevels, type Weld } from './vehicleLevels';
import { VEHICLE_WHOLE_CAP, type QualitySettings } from './quality';
import { jobPort } from '../jobs/jobPool';
import { provideLanes } from './pagePorts';
import { lodPool } from './people/lodPool';
import { providePeopleLod } from './people/lodPort';

// The page that draws people and vehicles hands their bakes, garments and levels' simplifier the job system's lanes (`pagePorts.ts`, `lodPort.ts`): the cooked bodies' code imports neither.
provideLanes('citizenBake', () => jobPort('citizenBake'));
provideLanes('garmentPadding', () => jobPort('garmentPadding'));
providePeopleLod(lodPool);

/** Vehicles and riders use the original instanced batches. */

/** DO NOT stop drawing at this number again: past 1,200 parked cars, the rest vanished from the town. */
const MAX_VEHICLES = FLEET_CEILING;
const MAX_PEDS = PED_CEILING;
/** What a car off the road stands on (`offRoadDeck`): the terrain and the ground as cut and filled, the roads' heights */
const OFF_ROAD_GROUND: readonly ChangeKind[] = ['terrain', 'ground', 'elevation', 'roads', 'lots', 'buildings'];

/** Zoom at which the closest band switches on. */
const NEAR_DETAIL_ZOOM = perM(1.375);

/** Below this zoom a vehicle is its far proxy (`VehicleModel.far`) */
const FAR_BODY_ZOOM = perM(1.75);
/** From this zoom the cabin and the people in it are drawn (the tier may ask for more, `QualitySettings.occupantZoom`). */
const OCCUPANT_ZOOM = perM(3);

/** Each vehicle's own level, by the screen's scale where it stands */
const VEHICLE_HYSTERESIS = 0.1;
/** A car's length, for the smallest scale anything is drawn at (2 px). */
const CAR_LENGTH = m(4.5);
/** At most this many vehicles whole at once: past it, the smallest on the screen are drawn a level down. */
const VEHICLE_NEAR_CAP = VEHICLE_WHOLE_CAP;
/** A culled vehicle's deck is reused while it has moved under this; the steepest a road climbs (`ROAD_TUNING.grade.refuse`), and the sphere's growth per metre climbed (its centre rises with its radius, `vehicleVisible`). */
const CULL_REUSE = m(24);
const CULL_GRADE = 0.35;
const CULL_GROWTH = 1.5;
/** The side of the client's cells of parked cars (`fleetGrid.ts`), and half their diagonal. */
const FLEET_CELL = m(64);
const CELL_HALF_DIAGONAL = FLEET_CELL * Math.SQRT1_2;
/** Relative slack of the screen's scale worked out from its field (`depthField`) against the asked one: a cell at a level's edge is walked. */
const FIELD_SLACK = 1e-6;
/** DO NOT size a part by the fleet's ceiling: 8 bodies x ~25 parts x 1,200 x 76 B was 15-22 MB of CPU and GPU; every part starts here and doubles with what is drawn (`growPart`). */
const PART_CAPACITY = 16;

const SIDES = [1, -1] as const;

/** A tint as the instance colours hold it (the working colour space), and a lamp's glow by it (`LAMP_GAIN`): worked out once a colour. */
interface Tint {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly glow: number;
}

/** Lamp state for the vehicle currently being drawn. */
interface LampState {
  /** Headlamp colour: lit, or the unlit lens of a parked car. */
  head: Tint;
  tail: Tint;
  /** Lit indicator side: +1 left, -1 right, 0 none. Already includes the flash. */
  indicate: number;
  /** Front-wheel steering angle, radians, positive to the left. */
  steer: number;
  /** Rolling angle of the wheels, radians. */
  spin: number;
  /** Angle of a bicycle's cranks, radians. */
  crank: number;
}

interface AgentRenderOptions {
  readonly pedestrianDetail?: 0 | 1 | 2;
  readonly pedestrianVisible?: (x: number, y: number, height: number) => boolean;
  /** Whether a vehicle of this reach, centred here, can be on screen or cast a shadow onto it. */
  readonly vehicleVisible?: (x: number, y: number, height: number, radius: number) => boolean;
  /** Whether such a sphere is wholly inside the view (every plane of the frustum farther than its radius): a cell of parked cars standing as drawn is not walked. */
  readonly vehicleInside?: (x: number, y: number, height: number, radius: number) => boolean;
  /** The ground where a vehicle `vehicleVisible` can pass stands (`frustumGround.ts`): only the vehicles there are asked of the client's grid; none given, every one. */
  readonly vehicleBox?: Readonly<GroundBox>;
  /** Zoom from which vehicle cabins and occupants are drawn. */
  readonly occupantZoom?: number;
  /** The tier's vehicle and people detail (`quality.ts`): none given, what every tier but the weak one draws. */
  readonly tier?: Pick<QualitySettings, 'vehicleErrorPixels' | 'vehicleWholeCap' | 'hairStrandPeople'>;
  /** Each motor vehicle drawn: where its tail smoke leaves from (`exhaust.ts`). */
  readonly exhaust?: (x: number, y: number, z: number, angle: number, length: number, speed: number, dusty: boolean) => void;
  /** The bodies of people killed by a blow (`ragdoll.ts`), drawn with the crowd's own meshes. */
  readonly ragdolls?: (citizens: RagdollCitizens) => void;
  /** Somebody whose own body lies on the ground (`ragdoll.ts`): not drawn standing as well. */
  readonly hiddenPed?: (id: number) => boolean;
  /** Where the camera is: the people nearest it get their hair's strands (`?bodies=proc`). */
  readonly eye?: Vector3;
  /** How tall something `height` high standing at (x, y, z) is on the screen, pixels */
  readonly personPixels?: (x: number, y: number, z: number, height: number) => number;
  /** Pixels a world unit across the screen at (x, y, z): each vehicle's level of detail. */
  readonly screenScale?: (x: number, y: number, z: number) => number;
  /** Pixels drawn per CSS pixel (the canvas's buffer over its size): a part's level is chosen by its error in pixels drawn. */
  readonly pixelRatio?: number;
  /** Whether shadows are drawn at all (the quality tier): the far ones' soft discs follow it. */
  readonly shadows?: boolean;
}

export interface AgentMeshes {
  readonly meshes: readonly Object3D[];
  /** Whether the last `sync` switched the two-wheelers between casting into the shadow map and a soft disc under them */
  readonly castersChanged: boolean;
  /** Whether the last `sync` drew anything into the shadow map (vehicles, two-wheelers, people): the map's moving casters. */
  readonly casting: boolean;
  /** The records the page holds for the vehicles and walkers (by id, by cell, kept): bounded by the view, the region and the last seconds, never by the map or the path. */
  readonly held: { readonly vehicles: number; readonly cells: number; readonly kept: number; readonly people: number };
  sync(world: SimClient, net: Network, alpha: number, detailed: boolean, zoom?: number, options?: AgentRenderOptions): void;
  /** Every figure drawn last frame and the body it was cast as (`citizenCasting.ts`). */
  census(): ReturnType<ReturnType<typeof createRiggedCitizens>['census']>;
  /** The burnt-out shell of this vehicle's own body */
  carcass(vehicle: { readonly id: number; readonly archetype: Archetype }, intact?: boolean): BufferGeometry | null;
  /** How far each procedural person's drawn skeleton is from a body (the weapons lab's mesh probe) */
  meshProbe(): { id: number; stretch: number; stretchBone: string; scale: number; scaleBone: string; held: boolean; clip: string }[];
  /** What is posing a procedural person now (the weapons lab): the baked clip played */
  animProbe(id: number): { clip: string; time: number; duration: number; weight: number; paused: boolean; layers: string[]; source: 'animation' | 'physics' } | null;
  /** Plays `clip` on a person whatever they are doing (the lab's clip check); null gives them back. */
  forceClip(id: number, clip: ProcClip | null): void;
  /** The body a vehicle's driver or rider is drawn with, for their body when they are thrown out (`Occupant.index`). */
  driverBody(vehicle: SimVehicle, x: number, y: number): number | null;
  /** Called for each walker drawn bleeding (a limb lost), to drip blood where they go. */
  setBleed(fn: (id: number, x: number, y: number, z: number) => void): void;
  /** Lamps burn brighter than white after dark, so headlights and tail lights glow. */
  setNight(dark: number): void;
  /** The people's skeletons (procedural and cooked), worked out on the GPU: once a frame, after `sync`, before the scene is drawn. */
  renderPalettes(renderer: WebGLRenderer): void;
  dispose(): void;
}

/** Time constant of the pitch and roll ease, seconds. */
const SUSPENSION_TAU = 0.06;

type ElevationAt = (x: number, y: number, segment?: SegmentId) => number;

// ---------------------------------------------------------------- variation

/** A cheap integer avalanche hash. */
export function agentHash(id: number): number {
  let h = (id | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** A slice of a hash as an index into `n` items. */
const pick = (h: number, shift: number, n: number): number => (h >>> shift) % n;
/** Reads a palette entry, with the indexing narrowed away. */
const from = (palette: readonly number[], h: number, shift: number): number =>
  palette[pick(h, shift, palette.length)] as number;

/** Skin tones, light to dark. */
export const SKIN_TONES: readonly number[] = [
  0xf2d3b6, 0xe6b98f, 0xd19a6a, 0xa9714a, 0x7d4e30, 0x4e3120,
];

export const SHIRT_COLOURS: readonly number[] = [
  0xd8dde2, 0x2f5f92, 0xb8432f, 0x3f7d5c, 0xe0b83f, 0x8a4f8c, 0x2b2f36, 0xd77c3a, 0xf0e6d2,
  0x5d6b7a,
];

const HELMET_COLOURS: readonly number[] = [0x1c1e22, 0xd8dbe0, 0xc0392b, 0x2c5f9e, 0xe0a33a];

/** Tints for parts that are never painted the vehicle's own colour. */
const RUBBER = 0x15181b;
const HUB = 0x9aa0a6;
const TRIM = 0x1b2328;
const CHROME = 0xb9bec4;
/** A number plate is retro-reflective, so unlit white is the honest material. */
const PLATE = 0xf0efe6;
/** A bus's destination blind: amber on black, read as lit amber. */
const DESTINATION = 0xffb13b;
/** A contrasting black roof panel (`VehicleLook.blackRoof`). */
const BLACK_ROOF = 0x15171a;

/** Seconds a change of a person's clip cross-fades over: about half a step at a walk */
const CLIP_FADE = 0.3;
/** The gaits, whose phase is the ground covered (one stride a cycle) and runs on from one into another. */
const gaitClip = (c: ProcClip): boolean => c === 'walk' || c === 'run' || c === 'sprint' || c === 'hurtWalk' || c === 'hurtRun';
const HEADLAMP = 0xfff3c4;
const TAILLAMP = 0xff3b2f;
/** A parked car's lamps, switched off: clear and red lenses, unlit. */
const HEADLAMP_OFF = 0x8c8f8e;
const TAILLAMP_OFF = 0x5e1712;
/** A tail lamp with the brakes on. */
const BRAKELAMP = 0xff1a08;
/** The amber of an indicator, on the side the vehicle is moving towards. */
const INDICATOR = 0xffa11c;
/** Deceleration, in units per second per second, at which the brake lights come on. */
const BRAKE_DECEL = 1.0;
/** How much brighter each lit lamp burns after dark (`lightLevels.ts`), by its colour */
const LAMP_GAIN: ReadonlyMap<number, number> = new Map([
  [HEADLAMP, nightGain(HEADLAMP, NIGHT_LUMINANCE.headlamp)],
  [TAILLAMP, nightGain(TAILLAMP, NIGHT_LUMINANCE.tailLamp)],
  [BRAKELAMP, nightGain(BRAKELAMP, NIGHT_LUMINANCE.brakeLamp)],
  [INDICATOR, nightGain(INDICATOR, NIGHT_LUMINANCE.indicator)],
  [DESTINATION, nightGain(DESTINATION, NIGHT_LUMINANCE.destination)],
]);
const BOX_BODY = 0xe6e8ea;

/** Height of a seated head above the middle of its torso. */
const SEAT_HEAD_RISE = m(0.38);

export interface VehicleLook {
  /** Figures to draw, driver first. Never more than the class has seats. */
  readonly occupants: number;
  /** Bit 0 is the offside window, bit 1 the kerbside one. Set means down. */
  readonly windowsDown: number;
  /** How far a lowered window is down: 0.45 part-way, 1 fully into the door. */
  readonly windowDrop: number;
  readonly driverSkin: number;
  readonly driverShirt: number;
  readonly passengerSkin: number;
  readonly passengerShirt: number;
  readonly helmet: number;
  /** Second body colour, for a truck's box and a bus's roof. */
  readonly accent: number;
  /** A panoramic glass roof. */
  readonly glassRoof: boolean;
  /** A contrasting black roof panel. */
  readonly blackRoof: boolean;
}

/** How a door's window is drawn with a share `drop` of it lowered (0 shut, 1 fully down), written into `out` (the frame's own, `drawCar`). */
export function windowPane(door: { glass: BufferGeometry }, drop: number,
  out: { visible: boolean; up: number; sy: number } = { visible: true, up: 0, sy: 1 }): { visible: boolean; up: number; sy: number } {
  if (drop >= 0.98) { out.visible = false; out.up = 0; out.sy = 0; return out; }
  if (drop <= 0) { out.visible = true; out.up = 0; out.sy = 1; return out; }
  if (!door.glass.boundingBox) door.glass.computeBoundingBox();
  const bottom = door.glass.boundingBox?.min.y ?? 0;
  const sy = 1 - drop;
  out.visible = true; out.up = bottom * (1 - sy); out.sy = sy;
  return out;
}

/** Everything about how one vehicle's occupants and windows look, from its id. */
export function vehicleLook(id: number, seats: number): VehicleLook {
  const h = agentHash(id ^ 0x2545f491);
  const g = agentHash(id ^ 0x27220a95);
  const room = Math.max(1, Math.floor(seats));
  return {
    occupants: 1 + pick(h, 6, room),
    // Most cars closed; three in ten with a window or both front ones down.
    windowsDown: pick(h, 2, 10) < 7 ? 0 : pick(h, 2, 10) - 6,
    windowDrop: pick(g, 9, 2) === 0 ? 0.45 : 1,
    driverSkin: from(SKIN_TONES, h, 14),
    driverShirt: from(SHIRT_COLOURS, h, 20),
    passengerSkin: from(SKIN_TONES, g, 6),
    passengerShirt: from(SHIRT_COLOURS, g, 12),
    helmet: from(HELMET_COLOURS, g, 18),
    accent: pick(g, 24, 3) === 0 ? BOX_BODY : from(SHIRT_COLOURS, g, 26),
    // Always a solid roof: a glass one showed the whole cabin from above, and read as a car with its roof missing.
    glassRoof: false,
    blackRoof: pick(g, 28, 5) === 0,
  };
}

// ---------------------------------------------------------------- two-wheelers

/** Crank turns per wheel turn of a bicycle. */
const CRANK_RATIO = 0.57;
/** Steepest lean drawn, radians (about 35 degrees). */
const MAX_LEAN = 0.6;
const GRAVITY = m(9.81);
/** How fast a lean follows the bend, per second. */
const LEAN_RATE = 6;

/** A vehicle's pose and its frame on the road, written in place for each vehicle drawn */
const POSE = newPose();
const WANT = { deck: 0, pitch: 0, roll: 0 };

/** A two-wheeler's lean as last drawn (`VehicleDraw`): known for the view it was drawn for. */
interface LeanState { leanKnown: boolean; lean: number; leanAge: number }

/** How far a two-wheeler leans into the bend it is on */
function leanOf(v: SimVehicle, state: LeanState): number {
  const target = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.atan((v.v * v.v * v.curvature) / GRAVITY)));
  if (!state.leanKnown) {
    state.leanKnown = true;
    state.lean = target;
    state.leanAge = v.age;
    return target;
  }
  const dt = Math.max(0, Math.min(0.2, v.age - state.leanAge));
  state.leanAge = v.age;
  state.lean += (target - state.lean) * (1 - Math.exp(-dt * LEAN_RATE));
  return state.lean;
}

// ---------------------------------------------------------------- people in vehicles

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** How much a two-wheeler is under way, 0 stopped (a foot down) to 1 riding. */
const riderMoving = (v: SimVehicle): number => smooth01((v.v / m(1) - 0.2) / 0.8);

// ---------------------------------------------------------------- doors and seats

/** Open fraction of one door, 0 shut to 1 fully open, from the simulation. */
function doorOpening(v: SimVehicle, door: number): number {
  return v.doors[door] ?? 0;
}

// ---------------------------------------------------------------- body plans

/** Per-class geometry, derived once at module load. */
interface BodyPlan {
  readonly shape: VehicleShape;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly wheelRadius: number;
  /** Tyre width. */
  readonly tread: number;
  /** Axle positions along the body, front first. */
  readonly axleAlong: readonly number[];
  /** Lateral offset of a wheel from the centreline. Zero for two-wheelers. */
  readonly axleSide: number;
  readonly cabinLength: number;
  readonly cabinAlong: number;
  readonly seats: number;
  /** Seated torso centre, and the head above it. */
  readonly seatY: number;
  readonly headY: number;
  /** First seat row, and the step back to the next. */
  readonly seatAlong: number;
  readonly seatPitch: number;
  readonly seatSide: number;
}

function bodyPlan(a: Archetype): BodyPlan {
  const twoWheeler = a.shape === 'motorcycle' || a.shape === 'bicycle';
  const bus = a.shape === 'bus';
  const truck = a.shape === 'truck';
  const tread = twoWheeler ? a.width * (a.shape === 'bicycle' ? 0.14 : 0.3) : a.width * 0.14;

  // Two axles straddle the body; three put one under the nose and a bogie at the back
  const axleAlong: readonly number[] = axleStations(a);

  // Seat heights put the heads inside the glazed band of each body plan
  const seatY = a.height * (bus ? 0.55 : truck ? 0.5 : 0.46);
  return {
    shape: a.shape,
    length: a.length,
    width: a.width,
    height: a.height,
    wheelRadius: a.wheelRadius,
    tread,
    axleAlong,
    axleSide: twoWheeler ? 0 : a.width * 0.5 - tread * 0.5,
    cabinLength: a.length * a.cabinFraction,
    cabinAlong: a.length * a.cabinShift,
    seats: a.seats,
    seatY,
    headY: seatY + SEAT_HEAD_RISE,
    seatAlong: bus ? a.length * 0.36 : a.length * a.cabinShift,
    seatPitch: bus ? -a.length * 0.24 : truck ? 0 : -a.length * 0.2,
    seatSide: a.width * 0.24,
  };
}

const PLANS: ReadonlyMap<string, BodyPlan> = new Map(
  ARCHETYPES.map((a) => [a.id, bodyPlan(a)] as const),
);
const FALLBACK_PLAN = bodyPlan(archetypeById('sedan'));
const planOf = (a: Archetype): BodyPlan => PLANS.get(a.id) ?? FALLBACK_PLAN;
/** The widest reach a vehicle is tested with (`vehicleVisible`'s radius): the view's ground box is grown by it. */
export const VEHICLE_REACH = Math.max(...[...PLANS.values(), FALLBACK_PLAN].map((plan) => plan.length * 0.5 + plan.height * 2));
/** Whether the vehicles' ground box holds every walker the view can show (`pedestrianVisible`: a sphere of 8 m 3 m over the feet). */
const PED_IN_BOX = VEHICLE_REACH >= m(11);

// ---------------------------------------------------------------- meshes

/** Who holds kept instances (`VehicleDraw`): each one's place in a part, moved when another kept one leaves. */
interface KeptHolder {
  readonly keptSlots: number[];
}

/** DO NOT write every vehicle's every instance each frame again: a parked car's stay where they were written (`kept`), only the frame's own are written and sent. */
interface Part {
  readonly mesh: InstancedMesh;
  /** Instances [0, kept) are the parked cars' standing still, written once; [kept, n) this frame's. */
  kept: number;
  /** Write cursor: back to `kept` at the top of every sync. */
  n: number;
  /** The holder of each kept instance and its place in the holder's list (`holders.length === kept`). */
  readonly holders: KeptHolder[];
  readonly holderAt: number[];
  /** Whether its instances are tinted (a part always is or never is): their colours go to the GPU with their matrices. */
  tinted: boolean;
  /** Instances changed since the GPU last took them, [lo, hi) (none while hi <= lo); the upload clears it (`onUpload`). */
  lo: number;
  hi: number;
  /** In the frame's list of parts drawn (`live`). */
  listed: boolean;
  /** Made to cast into the shadow map: a vehicle off the screen and in the shadows' reach writes only these (`castOnly`). */
  readonly casts: boolean;
  /** Instances drawn last frame: one gone changes the shadow as much as one moved. */
  shown: number;
  /** Whether it cast last frame: a part turned to cast, or not, changes the shadow too. */
  castLast: boolean;
}

/** A part over `mesh`: nothing drawn, every upload clearing what was waiting to go. */
function partOf(mesh: InstancedMesh, casts = false): Part {
  const part: Part = { mesh, kept: 0, n: 0, holders: [], holderAt: [], tinted: false, lo: 0, hi: 0, listed: false, casts, shown: 0, castLast: false };
  watchUploads(part);
  return part;
}

/** The GPU took the part's instances (three calls it once a matrix buffer is sent): nothing waits now. */
function watchUploads(part: Part): void {
  part.mesh.instanceMatrix.onUpload(() => { part.lo = 0; part.hi = 0; });
}

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  castShadow = true,
): Part {
  const count = PART_CAPACITY;
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Every part carries a colour per instance, white until tinted.
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  // Instances move every frame, so a bounding sphere computed once is wrong
  mesh.frustumCulled = false;
  mesh.count = 0;
  // Shown once something is written in it (`sync`); its programs are still built at load (`compileAsync` walks hidden meshes too).
  mesh.visible = false;
  return partOf(mesh, castShadow);
}

/** A part at each level (`vehicleLevels.ts`): `parts[k]` within `LEVEL_ERRORS[k - 1]`, `route[k]` the part drawn at level k (-1: none), the model's own until made. */
interface Ladder {
  readonly parts: readonly Part[];
  readonly route: number[];
}

/** The largest scale a road wheel's unit tyre and rim are drawn at (`placeWheels`): their levels are chosen by it. */
const tyreSize = (plan: BodyPlan): number => Math.max(plan.wheelRadius * 2, plan.tread);
const rimSize = (plan: BodyPlan): number => Math.max(plan.wheelRadius * 2 * 0.52, plan.tread * 1.1);
/** Every level a vehicle's parts are drawn at, as one number: a parked car's copied writes hold while it stays the same. */
const levelsKey = (plan: BodyPlan, pixels: number): number =>
  levelFor(pixels) + LEVELS * (levelFor(pixels * tyreSize(plan)) + LEVELS * levelFor(pixels * rimSize(plan)));

/** The screen scales (CSS pixels a unit) over which a standing vehicle drawn at `own` from `pixels` keeps its own level and its parts' (`levelsKey`): the open range [out.lo, out.hi]; none for a whole one (the cap's). */
function standingRange(plan: BodyPlan, own: number, pixels: number, ratio: number, occupantZoom: number, out: { lo: number; hi: number }): void {
  if (own >= 2) { out.lo = Infinity; out.hi = -Infinity; return; }
  // The hysteresis of `sync`'s own level: up at the next edge grown by a tenth, down at its own edge.
  let lo = own === 1 ? FAR_BODY_ZOOM : 2 / CAR_LENGTH;
  let hi = (own === 1 ? occupantZoom : FAR_BODY_ZOOM) * (1 + VEHICLE_HYSTERESIS);
  // DO NOT make an array of the three sizes per car: three passes, one a part's scale.
  for (let k = 0; k < 3; k++) {
    // `levelFor` keeps level L while LEVEL_ERRORS[L - 1] * p <= ERROR_PIXELS < LEVEL_ERRORS[L] * p.
    const unit = ratio * (k === 0 ? 1 : k === 1 ? tyreSize(plan) : rimSize(plan)), level = levelFor(pixels * unit);
    if (level < LEVEL_ERRORS.length) lo = Math.max(lo, ERROR_PIXELS / (LEVEL_ERRORS[level]! * unit));
    if (level > 0) hi = Math.min(hi, ERROR_PIXELS / (LEVEL_ERRORS[level - 1]! * unit));
  }
  out.lo = lo; out.hi = hi;
}

/** The part of `ladder` for `level`; null when nothing of it is left to draw there. */
function rung(ladder: Ladder, level: number): Part | null {
  const at = ladder.route[level]!;
  return at < 0 ? null : ladder.parts[at]!;
}

/** `groundAt`: what a walker off the streets stands on (a yard, a terrace, the paving, the land); `roughGroundAt` */
export function createAgentMeshes(elevationAt: ElevationAt, onAssetsReady: () => void = () => {},
  groundAt?: (x: number, y: number) => number,
  lotAt?: (building: number, x: number, y: number) => number,
  roughGroundAt?: (x: number, y: number) => number): AgentMeshes {
  // Paint, trim and the cabin read a vertex colour that multiplies the instance colour
  const paint = new MeshPhysicalMaterial({
    roughness: 0.38, metalness: 0.28, clearcoat: 1, clearcoatRoughness: 0.07,
    envMapIntensity: 1.35, vertexColors: true,
  });
  const trim = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35, vertexColors: true });
  const glassMaterial = new MeshStandardMaterial({
    color: 0x7896a2,
    roughness: 0.12,
    metalness: 0.04,
    transparent: true,
    // Keep a cool tint while letting seated people read through the panes.
    opacity: 0.34,
    envMapIntensity: 0.8,
    // Panes are single sheets seen from both sides
    side: DoubleSide,
    // In ONE pass. three draws a transparent double-sided material twice, back faces then front
    forceSinglePass: true,
    depthWrite: false,
  });
  // The cabin: seats, dashboard, wheel.
  const cabinMaterial = new MeshStandardMaterial({ roughness: 0.9, metalness: 0.02, vertexColors: true });
  const rubber = new MeshStandardMaterial({ roughness: 0.92, metalness: 0.05 });
  // Unlit, so a lamp stays bright inside a shadow — the only thing in the scene for which that is correct.
  const lampMaterial = new MeshBasicMaterial({ toneMapped: false });
  const lampDark = { value: 0 };
  lampMaterial.onBeforeCompile = (shader) => {
    shader.uniforms['uDark'] = lampDark;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDark;\nvarying float vGlow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 1.0 + uDark * vGlow;');
  };
  lampMaterial.customProgramCacheKey = () => 'vehicle-lamp-glow';
  const cloth = new MeshStandardMaterial({ roughness: 0.85, metalness: 0 });

  const unitBox = new BoxGeometry(1, 1, 1);
  // A dog's body: shoulders a little wider than the waist.
  const torsoGeometry = new BoxGeometry(1, 1, 1);
  taper(torsoGeometry, 0.92, 1.2);
  const wheelGeometry = tyreGeometry();
  const hubGeometry = rimGeometry();
  // A bicycle's tyre is a thin hoop and its wheel is spokes, not a disc.
  const thinTyreGeometry = tyreGeometry(0.035);
  const spokedGeometry = spokedRimGeometry();
  const headGeometry = new SphereGeometry(0.5, 10, 7);

  const wheels = instanced('vehicle-wheels', wheelGeometry, rubber);
  const hubs = instanced('vehicle-hubs', hubGeometry, trim, false);
  const thinWheels = instanced('bicycle-wheels', thinTyreGeometry, rubber);
  const spokes = instanced('bicycle-spokes', spokedGeometry, trim, false);
  const lamps = instanced('vehicle-lamps', unitBox, lampMaterial, false);
  /** Each lamp's glow (`LAMP_GAIN`): a per-instance attribute of the lamps' box, replaced when they grow (`growPart`). */
  let lampGlow = new InstancedBufferAttribute(new Float32Array(PART_CAPACITY), 1);
  lampGlow.setUsage(DynamicDrawUsage);
  unitBox.setAttribute('glow', lampGlow);
  // A motorcyclist's helmet: a smooth shell, glossy like paint.
  const helmetGeometry = merge([new SphereGeometry(0.5, HELMET_SEGMENTS.width, HELMET_SEGMENTS.height)]);
  const helmets = instanced('rider-helmets', helmetGeometry, paint);

  const parts: readonly Part[] = [wheels, hubs, thinWheels, spokes, lamps, helmets];
  /** One set of instanced meshes per car class, built from its own model (`vehicleModels.ts`) */
  interface CarParts {
    readonly model: VehicleModel;
    /** The body, glazing and cabin with every door shut: one instance each, at the level its size on the screen allows. */
    readonly shell: Ladder;
    readonly glass: Ladder;
    readonly interior: Ladder;
    /** The same while a door moves: the pieces, and each leaf on its own. */
    readonly openShell: Part;
    readonly openGlass: Part;
    readonly openInterior: Part;
    readonly doors: readonly Part[];
    readonly doorGlass: readonly Part[];
    readonly doorCards: readonly (Part | null)[];
    readonly trim: Ladder;
    /** The roof panel in paint, or in glass on a car with a panoramic roof. */
    readonly roof: Ladder | null;
    readonly roofGlass: Part | null;
    readonly accent: Ladder | null;
    /** The body, roof and accent of the middle level: the same, casting no shadow (a soft disc instead). */
    readonly shellLite: Ladder;
    readonly roofLite: Ladder | null;
    readonly accentLite: Ladder | null;
    readonly far: Part;
    readonly steering: Part | null;
  }
  const carParts = new Map<string, CarParts>();
  /** Which body a vehicle is drawn with: its class and, for a car, the style its id picks. */
  const bodyKey = (vehicle: SimVehicle): string => {
    const a = vehicle.archetype;
    if (a.shape === 'bus') return `${a.id}:bus`;
    if (a.shape === 'truck') return `${a.id}:truck`;
    return `${a.id}:${carStyleOf(a, agentHash(vehicle.id ^ 0x57e1))}`;
  };
  const modelGeometries: BufferGeometry[] = [];
  /** Each source geometry's levels, made once (off the main thread) and shared by every ladder drawn from it. */
  const levelsOf = new Map<BufferGeometry, Promise<(BufferGeometry | null)[]>>();
  /** Moves when levels arrive: a parked car's kept instances name the parts it was drawn with (`VehicleDraw` kept). */
  let levelsVersion = 0;
  const ladderParts: Part[] = [];
  /** `base` and a part per coarser level, empty until drawn (they grow, `growPart`), routed to `base` until the levels are made. */
  const ladder = (base: Part, weld: Weld): Ladder => {
    const parts = [base];
    for (let k = 1; k < LEVELS; k++) {
      const part = instanced(`${base.mesh.name}@${k}`, base.mesh.geometry, base.mesh.material as Material, base.mesh.castShadow);
      parts.push(part);
      ladderParts.push(part);
    }
    const made: Ladder = { parts, route: new Array<number>(LEVELS).fill(0) };
    const source = base.mesh.geometry;
    let levels = levelsOf.get(source);
    if (!levels) {
      levels = partLevels(source, weld);
      levelsOf.set(source, levels);
      void levels.then((all) => { for (const g of new Set(all)) if (g && g !== source) modelGeometries.push(g); });
    }
    void levels.then((all) => {
      for (let k = 1; k < all.length; k++) {
        const geometry = all[k];
        if (!geometry) made.route[k] = -1;
        else if (geometry === all[k - 1]) made.route[k] = made.route[k - 1]!;
        else { parts[k]!.mesh.geometry = geometry; made.route[k] = k; }
      }
      levelsVersion++;
      onAssetsReady();
    }, (error: unknown) => console.error(`[vehicles] ${base.mesh.name}: levels not made, drawn whole`, error));
    return made;
  };
  const wheelLevels = ladder(wheels, 'boxes');
  const hubLevels = ladder(hubs, 'boxes');
  // One set per class and body style: a sedan may be drawn as an estate and an SUV as a pick-up
  const bodies: { key: string; model: VehicleModel }[] = [];
  for (const archetype of ARCHETYPES) {
    if (archetype.shape === 'car') {
      for (const style of carStylesFor(archetype)) bodies.push({ key: `${archetype.id}:${style}`, model: buildCarModel(archetype, style) });
    } else if (archetype.shape === 'bus') bodies.push({ key: `${archetype.id}:bus`, model: buildBusModel(archetype) });
    else if (archetype.shape === 'truck') bodies.push({ key: `${archetype.id}:truck`, model: buildTruckModel(archetype) });
  }
  for (const { key, model } of bodies) {
    const id = key.replace(':', '-');
    const own = new Set<BufferGeometry>([model.shell, model.glass, model.interior, model.openShell, model.openGlass,
      model.openInterior, model.trim, model.far, ...model.doors.flatMap((d) => [d.panel, d.glass, ...(d.card ? [d.card] : [])])]);
    if (model.roof) own.add(model.roof);
    if (model.accent) own.add(model.accent);
    if (model.steering) own.add(model.steering.geometry);
    modelGeometries.push(...own);
    carParts.set(key, {
      model,
      shell: ladder(instanced(`car-${id}-shell`, model.shell, paint), 'smooth'),
      glass: ladder(instanced(`car-${id}-glass`, model.glass, glassMaterial, false), 'smooth'),
      interior: ladder(instanced(`car-${id}-interior`, model.interior, cabinMaterial, false), 'boxes'),
      openShell: instanced(`car-${id}-openshell`, model.openShell, paint),
      openGlass: instanced(`car-${id}-openglass`, model.openGlass, glassMaterial, false),
      openInterior: instanced(`car-${id}-openinterior`, model.openInterior, cabinMaterial, false),
      doors: model.doors.map((d, i) => instanced(`car-${id}-door${i}`, d.panel, paint)),
      doorGlass: model.doors.map((d, i) => instanced(`car-${id}-doorglass${i}`, d.glass, glassMaterial, false)),
      doorCards: model.doors.map((d, i) => d.card ? instanced(`car-${id}-doorcard${i}`, d.card, cabinMaterial, false) : null),
      trim: ladder(instanced(`car-${id}-trim`, model.trim, trim, false), 'boxes'),
      roof: model.roof ? ladder(instanced(`car-${id}-roof`, model.roof, paint), 'smooth') : null,
      roofGlass: model.roof ? instanced(`car-${id}-roofglass`, model.roof, glassMaterial, false) : null,
      accent: model.accent ? ladder(instanced(`car-${id}-accent`, model.accent, paint), 'smooth') : null,
      shellLite: ladder(instanced(`car-${id}-shell-lite`, model.shell, paint, false), 'smooth'),
      roofLite: model.roof ? ladder(instanced(`car-${id}-roof-lite`, model.roof, paint, false), 'smooth') : null,
      accentLite: model.accent ? ladder(instanced(`car-${id}-accent-lite`, model.accent, paint, false), 'smooth') : null,
      // A car under twelve pixels: its shadow is the soft disc under it.
      far: instanced(`car-${id}-far`, model.far, paint, false),
      steering: model.steering ? instanced(`car-${id}-wheel`, model.steering.geometry, cabinMaterial, false) : null,
    });
  }
  // The far proxy is drawn under FAR_BODY_ZOOM, a car under nine pixels long
  for (const c of carParts.values()) {
    // At most nine pixels long: an error of 5% of the car is under half a pixel there.
    void simplified(c.far.mesh.geometry, 0.03, 0.05).then((coarse) => {
      if (coarse === c.far.mesh.geometry) return;
      modelGeometries.push(coarse);
      c.far.mesh.geometry = coarse;
    });
  }
  // Each ladder's own level (its `parts[0]`); the coarser ones are in `ladderParts`.
  const carPartList: Part[] = [...carParts.values()].flatMap((c) => [
    c.shell.parts[0]!, c.glass.parts[0]!, c.interior.parts[0]!, c.openShell, c.openGlass, c.openInterior, ...c.doors, ...c.doorGlass,
    ...c.doorCards.filter((p): p is Part => p !== null), c.trim.parts[0]!, c.far, c.shellLite.parts[0]!,
    ...[c.roofGlass, c.steering].filter((p): p is Part => p !== null),
    ...[c.roof, c.accent, c.roofLite, c.accentLite].flatMap((l) => (l ? [l.parts[0]!] : [])),
  ]);

  /** A two-wheeler's parts, each at the level its size on the screen allows (`vehicleLevels.ts`), as a car's. */
  interface TwoWheelerParts {
    readonly model: TwoWheelerModel;
    readonly body: Ladder;
    readonly trim: Ladder;
    readonly steering: Ladder;
    readonly cranks: Ladder | null;
  }
  const twoWheelerParts = new Map<string, TwoWheelerParts>();
  for (const archetype of ARCHETYPES) {
    if (archetype.shape !== 'motorcycle' && archetype.shape !== 'bicycle') continue;
    const model = buildTwoWheelerModel(archetype);
    const id = archetype.id;
    modelGeometries.push(model.body, model.trim, model.steering, ...(model.cranks ? [model.cranks] : []));
    twoWheelerParts.set(id, {
      model,
      body: ladder(instanced(`bike-${id}-body`, model.body, paint), 'smooth'),
      trim: ladder(instanced(`bike-${id}-trim`, model.trim, trim), 'boxes'),
      steering: ladder(instanced(`bike-${id}-steering`, model.steering, trim, false), 'boxes'),
      cranks: model.cranks ? ladder(instanced(`bike-${id}-cranks`, model.cranks, trim, false), 'boxes') : null,
    });
  }
  const twoWheelerPartList: Part[] = [...twoWheelerParts.values()].flatMap((t) =>
    [t.body.parts[0]!, t.trim.parts[0]!, t.steering.parts[0]!, ...(t.cranks ? [t.cranks.parts[0]!] : [])]);
  const allParts: readonly Part[] = [...parts, ...carPartList, ...twoWheelerPartList, ...ladderParts];

  // The scenery's people: the few bodies of the scenery cast
  const pedestrians = createRiggedCitizens(CROWD_IDS, onAssetsReady);
  // The walkers drawn as procedural people (`people/proceduralCrowd.ts`, the player's choice of 2026-10-06)
  const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('bodies') === 'cooked'
    ? null : createProceduralCrowd({ unit: m(1) });
  /** Each walker's person; a person whose walker left (at the end of a road) waits in `procSpare` for the next one. */
  const procPeople = new Map<number, { person: ProceduralPerson | null; seen: number; at?: Matrix4; age?: PersonAgeClass; cover?: number }>();
  /** Whether a body suits a walker's age (the simulation's child, adult or elder: their pace, their company) */
  const procSuits = (person: ProceduralPerson, age: PersonAgeClass | undefined): boolean =>
    age === undefined || (age === 'child' ? person.band === 'child' : age === 'elder' ? person.band === 'senior'
      : person.band === 'young' || person.band === 'adult');
  /** A spare body of that age, taken out of the pool; null when there is none. */
  const procSpareFor = (age: PersonAgeClass | undefined): ProceduralPerson | null => {
    const i = procSpare.findIndex((p) => procSuits(p, age));
    return i >= 0 ? procSpare.splice(i, 1)[0]! : null;
  };
  const procSpare: ProceduralPerson[] = [];
  const PROC_CAP = PED_CEILING;
  /** Walkers waiting for a body of their own. */
  const procWaiting: number[] = [];
  /** One body made at a time: its vertices baked in a worker (`crowdBodies.ts`), DO NOT space them out on a clock. */
  let procBuilding = false;
  // Two spare bodies built while the map opens, drawn hidden
  if (procedural) {
    for (const seed of [0x51a7e, 0x2b0d1]) {
      void procedural.add(randomPerson(-seed, seed)).then((person) => {
        person.matrix.makeScale(0, 0, 0);
        procSpare.push(person);
      }, () => {});
    }
    // And the rest of the classes while the map is still opening, before the first walkers come in (`warmClasses`).
    void procedural.warmClasses().catch(() => {});
  }
  const procBuildNext = (): void => {
    if (procBuilding || !procWaiting.length) return;
    // A walker who got a freed body meanwhile, or left, needs none.
    let id: number | undefined;
    while (procWaiting.length) {
      const next = procWaiting.shift()!;
      const e = procPeople.get(next);
      if (e && !e.person) { id = next; break; }
    }
    if (id === undefined) return;
    const target = id;
    procBuilding = true;
    // Bodies of the other ages left over in the pool: the oldest given back
    while (procSpare.length > 12) procedural!.ragdoll.untwin(procSpare.shift()!);
    // Of the walker's age: a child 5 to 13, an elder 66 to 88, an adult between.
    const age = procPeople.get(target)?.age;
    const roll = ((Math.imul(target ^ 0x9e37, 2246822519) >>> 0) % 1000) / 1000;
    const years = age === 'child' ? 5 + roll * 8 : age === 'elder' ? 66 + roll * 22 : 18 + roll * 42;
    void procedural!.add(randomPerson(target, (Math.imul(target, 2654435761) >>> 0) + 1, age ? { body: { age: ageFromYears(years) } } : {})).then((person) => {
      const e = procPeople.get(target);
      if (e && !e.person) e.person = person;
      else { person.matrix.makeScale(0, 0, 0); procSpare.push(person); }
    }, () => { procPeople.delete(target); }).finally(() => { procBuilding = false; });
  };
  let procFrame = 0;
  /** This frame's measure of a person on the screen (`AgentRenderOptions.personPixels`). */
  let procPixels: AgentRenderOptions['personPixels'] | null = null;
  const procMatrix = new Matrix4(), procTurn = new Matrix4(), procSize = new Matrix4();
  /** A person drawn this frame: their pose picked (`procPose`), and a change of clip made a cross-fade. */
  const procDraw = (id: number, x: number, y: number, heading: number, deck: number, speed: number, walking: boolean, dt: number, activity?: string,
    lost?: readonly Severable[], act?: { readonly t: number; readonly hold: number },
    wound?: { readonly part: BodyPart; readonly grave: boolean }, age?: PersonAgeClass): void => {
    const before = procPeople.get(id)?.person ?? null;
    const was = before?.clip;
    const wasPhase = before?.phase ?? 0;
    procPose(id, x, y, heading, deck, speed, walking, dt, activity, lost, act, wound, age);
    const person = procPeople.get(id)?.person ?? null;
    // Somebody new in this body this frame starts as they are: nothing to fade from.
    if (!person || person !== before || was === undefined) return;
    const metres = speed / m(1);
    const out = person.fade;
    if (out) {
      out.phase += gaitClip(out.clip) ? dt * metres / Math.max(0.1, procedural!.stride(person, out.clip))
        : dt / procedural!.clipDuration(person, out.clip);
      out.weight -= dt / CLIP_FADE;
      if (out.weight <= 0) person.fade = undefined;
    }
    // One gait into another goes on through the same stride (`procPose`): no fade.
    if (person.clip !== was && !(gaitClip(was) && gaitClip(person.clip))) {
      person.fade = { clip: was, phase: wasPhase, weight: 1 };
    }
  };
  const procPose = (id: number, x: number, y: number, heading: number, deck: number, speed: number, walking: boolean, dt: number, activity?: string,
    lost?: readonly Severable[], act?: { readonly t: number; readonly hold: number },
    wound?: { readonly part: BodyPart; readonly grave: boolean }, age?: PersonAgeClass): void => {
    let entry = procPeople.get(id);
    if (!entry) {
      const spare = procSpareFor(age);
      if (spare) {
        // Somebody new in that body: none of the last one's wounds.
        procedural?.ragdoll.heal(spare);
        entry = { person: spare, seen: procFrame, ...(age ? { age } : {}) };
        procPeople.set(id, entry);
      } else {
        if (procPeople.size >= PROC_CAP) return;
        entry = { person: null, seen: procFrame, ...(age ? { age } : {}) };
        procPeople.set(id, entry);
        procWaiting.push(id);
      }
    }
    entry.seen = procFrame;
    const person = entry.person;
    if (!person) return;
    procMatrix.makeTranslation(x, deck, -y)
      .multiply(procTurn.makeRotationY(heading + Math.PI / 2))
      .multiply(procSize.makeScale(m(1), m(1), m(1)));
    person.matrix.copy(procMatrix);
    // How tall they stand on the screen: the level they are drawn at (`crowdLod.ts`).
    person.pixels = procPixels ? procPixels(x, y, deck, m(person.height)) : undefined;
    // Where they were last drawn: a ragdoll takes them from there when they drop out of the street
    (entry.at ??= new Matrix4()).copy(procMatrix);
    person.activity = activity;
    person.lost = lost;
    const forced = procForced.get(id);
    if (forced) {
      if (person.clip !== forced) { person.clip = forced; person.phase = 0; }
      person.phase += dt / procedural!.clipDuration(person);
      return;
    }
    procFrozen.delete(id);
    if (activity === 'flinch' && act) {
      // A first wound (`walk.ts` FLINCH), as GTA's shot peds take it
      person.activity = 'hurt';
      // The hit itself first, as captured (Quaternius Hit_Chest, a third of a second); then knocked back
      const hitFor = procedural!.ragdoll.duration(person, 'hit');
      const back = staggerSpeed(act.t) / m(1);
      if (act.t < hitFor) {
        if (person.clip !== 'hit') person.clip = 'hit';
        person.phase = Math.min(0.999, act.t / hitFor);
      } else if (back > 0.05) {
        // Knocked back: steps back as captured (CMU 76_11), played over the stagger.
        if (person.clip !== 'staggerBack') person.clip = 'staggerBack';
        person.phase = Math.min(0.999, (act.t - STAGGER_FROM) / STAGGER_TIME * 0.85);
      } else {
        if (person.clip !== 'idle') { person.clip = 'idle'; person.phase = 0; }
        person.phase += dt / procedural!.clipDuration(person);
      }
      const k = Math.min(1, Math.max(0, (act.t - 0.12) / 0.3));
      procedural!.ragdoll.posture(person, { hunch: (wound?.grave ? 0.55 : 0.42) * k, reach: Math.min(1, Math.max(0, (act.t - 0.2) / 0.35)), part: wound?.part ?? 'torso' });
      return;
    }
    if ((activity === 'crouch' || activity === 'mourn') && act && !wound) {
      // Crouching in fear (a `crouch` act): down into it (the crouch-down clip), held, and up again before the act ends
      const down = 0.5, up = 0.9;
      const next: ProcClip = act.t < down ? 'duck' : act.t > act.hold - up ? 'getUp' : 'cower';
      if (person.clip !== next) { person.clip = next; person.phase = 0; }
      if (next === 'duck') person.phase = Math.min(0.999, act.t / down);
      else if (next === 'getUp') person.phase = Math.min(0.999, (act.t - (act.hold - up)) / up);
      else person.phase += dt / procedural!.clipDuration(person);
      // Both hands over the head while down (GTA's cower), on as they duck; grieving beside somebody they walked with
      if (activity === 'mourn') {
        person.activity = 'cry';
        entry.cover = 0;
        procedural!.ragdoll.posture(person, null);
        return;
      }
      entry.cover = Math.min(1, act.t / 0.4) * Math.min(1, Math.max(0, (act.hold - act.t) / 0.5));
      procedural!.ragdoll.posture(person, { hunch: 0, reach: 0, part: 'torso', cover: entry.cover });
      return;
    }
    if (activity === 'crawl') {
      // Dragging themself off, gravely hurt: the captured crawl (CMU 111_03), stepped by the ground covered.
      person.activity = 'hurt';
      if (person.clip !== 'crawl') { person.clip = 'crawl'; person.phase = 0; }
      person.phase += dt * (speed / m(1)) / Math.max(0.05, procedural!.stride(person));
      entry.cover = 0;
      procedural!.ragdoll.posture(person, null);
      return;
    }
    if (activity === 'look' && act && !wound) {
      // A bystander's first moment after a shot (`walk.ts` frighten): turned to it, standing scared
      if (person.clip !== 'nervous') { person.clip = 'nervous'; person.phase = 0; }
      person.phase += dt / procedural!.clipDuration(person);
      entry.cover = 0;
      procedural!.ragdoll.posture(person, null);
      return;
    }
    // Hurt: a hand pressed to the wound over the captured hurt gaits - the injured run while they flee, the limp after
    const metres = speed / m(1);
    const hurtRun = wound !== undefined && walking && metres > (person.clip === 'hurtRun' ? 1.3 : 1.7);
    // Fleeing in panic: both hands over the head as they run
    const panicRun = !wound && activity === 'panic' && walking && metres > 1.6;
    entry.cover = (entry.cover ?? 0) + ((panicRun ? 1 : 0) - (entry.cover ?? 0)) * Math.min(1, dt * 5);
    procedural!.ragdoll.posture(person, wound ? { hunch: wound.grave ? 0.5 : walking && metres > 0.15 ? 0.08 : 0.42, reach: 1, part: wound.part }
      : entry.cover > 0.02 ? { hunch: 0, reach: 0, part: 'torso', cover: entry.cover } : null);
    if (wound) person.activity = 'hurt';
    // Running from danger runs, past a brisk walk; struck with fear
    if (activity === 'fall') {
      if (person.clip !== 'idle') { person.clip = 'idle'; person.phase = 0; }
      procedural!.ragdoll.posture(person, null);
      return;
    }
    const was = person.clip;
    const moving = walking && metres > 0.15;
    const sprint = metres > (was === 'sprint' ? 3.6 : 4.2);
    const run = metres > (was === 'run' || was === 'sprint' ? 2.1 : 2.6);
    const clip: ProcClip = activity === 'photo' && !moving ? 'photo'
      : moving ? (wound ? (hurtRun ? 'hurtRun' : 'hurtWalk') : sprint ? 'sprint' : run ? 'run' : 'walk') : 'idle';
    // Walk, run and sprint all start on the same foot: the stride goes on through a change of pace.
    if (person.clip !== clip) {
      if (!(gaitClip(was) && gaitClip(clip))) person.phase = 0;
      person.clip = clip;
    }
    if (gaitClip(clip)) person.phase += dt * metres / Math.max(0.1, procedural!.stride(person));
    else person.phase += dt / procedural!.clipDuration(person);
  };
  /** The cooked bodies as the ragdolls ask for them: no captured getting-up off the ground (the key poses then). */
  const riggedRagdoll: RagdollCitizens = Object.assign(Object.create(pedestrians) as typeof pedestrians, {
    clipPose: (index: number, key: 'crouchUp' | 'idle' | 'getUpFront' | 'getUpBack' | 'crawl', phase: number) =>
      key === 'getUpFront' || key === 'getUpBack' || key === 'crawl' ? null : pedestrians.clipPose(index, key, phase),
  });
  /** Gone from the street: hidden; gone a second, its person freed for the next walker. */
  const procFinish = (eye: Vector3 | undefined, live: ReadonlySet<number>): void => {
    for (const [id, entry] of procPeople) {
      if (entry.seen === procFrame) continue;
      // Those a ragdoll holds (struck, down, or dead) keep their person.
      if (!entry.person) { if (!live.has(id) && !procHeld.has(id)) procPeople.delete(id); continue; }
      if (procHeld.has(id)) continue;
      entry.person.matrix.makeScale(0, 0, 0);
      // Kept a few frames off the street
      if (!live.has(id) && procFrame - entry.seen > 3) { procPeople.delete(id); procSpare.push(entry.person); }
    }
    // A freed body goes at once to a walker still waiting for one.
    for (let i = 0; i < procWaiting.length && procSpare.length; i++) {
      const e = procPeople.get(procWaiting[i]!);
      if (!e || e.person) continue;
      const spare = procSpareFor(e.age);
      if (spare) { procedural?.ragdoll.heal(spare); e.person = spare; procWaiting.splice(i--, 1); }
    }
    procBuildNext();
    // `procedural.update` runs after the ragdolls have posed those they hold (`sync`).
    void eye;
    procFrame++;
  };
  /** The ragdolls' view of the people (`ragdoll.ts` RagdollCitizens) */
  const procHeld = new Set<number>(), procHeldNow = new Set<number>();
  /** The walkers of the simulation this frame (`sync`), one set for every frame. */
  const procLive = new Set<number>();
  /** The tick `procLive` was gathered for, and how many walkers it had. */
  let procLiveTick = -1, procLiveViews = -1;
  /** People made to play a clip (`forceClip`), and those whose clip did not move this frame. */
  const procForced = new Map<number, ProcClip>();
  const procFrozen = new Set<number>();
  /** Drips blood where a wounded walker drawn procedurally goes (`setBleed`). */
  let procBleed: ((id: number, x: number, y: number, z: number) => void) | null = null;
  /** Pieces torn off procedural people, drawn apart (`RagdollCitizens.twin`): indices from `TWIN_BASE` down. */
  const procTwins = new Map<number, ProceduralPerson>();
  const TWIN_BASE = -1_000_000_000;
  let procTwinNext = 0;
  const procOf = (index: number): ProceduralPerson | null => (index <= TWIN_BASE ? procTwins.get(index) ?? null
    : index < 0 ? procPeople.get(-1 - index)?.person ?? null : null);
  const procScale = new Matrix4();
  const procRagdoll: RagdollCitizens = {
    capturedPose(id) {
      const entry = procPeople.get(id);
      const person = entry?.person;
      const palette = person && entry.at && procedural ? procedural.ragdoll.pose(person) : null;
      if (!person || !palette || !entry.at) return pedestrians.capturedPose(id);
      return { index: -1 - id, palette, transform: entry.at.clone().multiply(procScale.makeScale(person.scale, person.scale, person.scale)) };
    },
    skeletonOf(index) {
      const person = procOf(index);
      return person && procedural ? procedural.ragdoll.skeleton(person) : pedestrians.skeletonOf(index);
    },
    drawPalette(index, palette, instance, charred, alive) {
      const person = procOf(index);
      if (!person || !procedural) { pedestrians.drawPalette(index, palette, instance, charred); return; }
      // On the ground: in pain if alive, slack if not.
      person.activity = alive ? 'hurt' : 'dead';
      if (index <= TWIN_BASE) {
        person.matrix.copy(instance).multiply(procScale.makeScale(1 / person.scale, 1 / person.scale, 1 / person.scale));
        procedural.ragdoll.hold(person, palette);
        return;
      }
      // The first piece of the body is the person; pieces torn off are their twins (`twin`).
      const id = -1 - index;
      if (procHeldNow.has(id)) return;
      procHeldNow.add(id);
      person.matrix.copy(instance).multiply(procScale.makeScale(1 / person.scale, 1 / person.scale, 1 / person.scale));
      procedural.ragdoll.hold(person, palette);
    },
    clipPose(index, key, phase) {
      const person = procOf(index);
      if (!person || !procedural) return key === 'crawl' ? null : pedestrians.clipPose(index, key === 'getUpFront' || key === 'getUpBack' ? 'crouchUp' : key, phase);
      const clip = key === 'crouchUp' ? 'getUp' : key === 'getUpFront' ? 'riseFront' : key === 'getUpBack' ? 'riseBack' : key === 'crawl' ? 'crawl' : 'idle';
      const palette = procedural.ragdoll.standing(person, phase, clip);
      return palette ? { palette, duration: clip === 'idle' ? 1.2 : procedural.ragdoll.duration(person, clip) } : null;
    },
    loadedIndices: () => pedestrians.loadedIndices(),
    twin(index) {
      const person = procOf(index);
      // A cooked body draws as many palettes as it has pieces.
      if (!person || !procedural) return index >= 0 ? index : null;
      const twin = procedural.ragdoll.twin(person);
      if (!twin) return null;
      const key = TWIN_BASE - procTwinNext++;
      procTwins.set(key, twin);
      return key;
    },
    untwin(index) {
      const twin = procTwins.get(index);
      if (!twin || !procedural) return;
      procedural.ragdoll.untwin(twin);
      procTwins.delete(index);
    },
    char(index) {
      const person = procOf(index);
      if (person && procedural) procedural.ragdoll.char(person, true);
    },
    wound(index, part) {
      const person = procOf(index);
      if (!person || !procedural) return;
      procedural.ragdoll.wound(person, part);
      // The jerk of the hit is the captured one now (the `hit` clip, `procDraw` flinch), not a turn of the spine laid over the clip.
    },
    drench(index) {
      const person = procOf(index);
      if (person && procedural) procedural.ragdoll.drench(person);
    },
  };
  /** The soft shadow under a vehicle below the whole level (`blobShadows.ts`): a part like the others, a parked car's kept with it. */
  const blobs = partOf(blobMesh('vehicle-shadows', MAX_VEHICLES, 0.4));
  const meshes = [...allParts.map((part) => part.mesh), blobs.mesh, pedestrians.group, ...(procedural ? [procedural.group] : [])];

  const object = new Object3D();
  // Yaw outermost, so the third Euler component becomes a rotation about the agent's own lateral axis
  object.rotation.order = 'YXZ';
  const colour = new Color();

  // The palettes hold a few dozen distinct strings between them, so caching by the string avoids running the CSS parser
  const hexCache = new Map<string, number>();
  const hexOf = (css: string): number => {
    let hex = hexCache.get(css);
    if (hex === undefined) {
      colour.set(css);
      hex = colour.getHex();
      hexCache.set(css, hex);
    }
    return hex;
  };
  /** DO NOT convert a tint at every instance written: three sRGB-to-linear powers a write; each colour once (`setHex`, as `setColorAt` was given). */
  const tints = new Map<number, Tint>();
  const tintOf = (hex: number): Tint => {
    let tint = tints.get(hex);
    if (!tint) {
      colour.setHex(hex);
      tint = { r: colour.r, g: colour.g, b: colour.b, glow: LAMP_GAIN.get(hex) ?? 0 };
      tints.set(hex, tint);
    }
    return tint;
  };
  const T_RUBBER = tintOf(RUBBER), T_HUB = tintOf(HUB), T_TRIM = tintOf(TRIM), T_CHROME = tintOf(CHROME);
  const T_PLATE = tintOf(PLATE), T_DESTINATION = tintOf(DESTINATION), T_BLACK_ROOF = tintOf(BLACK_ROOF);
  const T_HEADLAMP = tintOf(HEADLAMP), T_TAILLAMP = tintOf(TAILLAMP), T_HEADLAMP_OFF = tintOf(HEADLAMP_OFF), T_TAILLAMP_OFF = tintOf(TAILLAMP_OFF);
  const T_BRAKELAMP = tintOf(BRAKELAMP), T_INDICATOR = tintOf(INDICATOR);

  // Frame of the agent currently being written.
  let occupantBand = 0;
  let fx = 0;
  let fy = 0;
  let fdx = 1;
  let fdy = 0;
  let fyaw = 0;
  let fdeck = 0;
  // Lean of a two-wheeler into a bend, radians, positive to the left
  let froll = 0;
  let fcos = 1;
  let fsin = 0;
  /** THE vehicle's one transform, as a rotation */
  const fq = new Quaternion();
  const qPitch = new Quaternion();
  const qRoll = new Quaternion();
  const qLocal = new Quaternion();
  /** The same as a matrix, its origin at the vehicle's (three's axes): every part's instance is this times the part's own place, turn and size. */
  const frameMatrix = new Matrix4();
  const F = frameMatrix.elements;
  const AXIS_Y = new Vector3(0, 1, 0);
  const AXIS_Z = new Vector3(0, 0, 1);
  const AXIS_X = new Vector3(1, 0, 0);
  const eulerScratch = new Object3D();
  eulerScratch.rotation.order = 'YXZ';

  const frameAt = (x: number, y: number, angle: number, deck: number, roll = 0, pitch = 0, roadRoll = 0): void => {
    fx = x;
    fy = y;
    fyaw = angle;
    fdx = Math.cos(angle);
    fdy = Math.sin(angle);
    fdeck = deck;
    froll = roll;
    fcos = Math.cos(roll);
    fsin = Math.sin(roll);
    fq.setFromAxisAngle(AXIS_Y, angle);
    qPitch.setFromAxisAngle(AXIS_Z, pitch);
    qRoll.setFromAxisAngle(AXIS_X, roadRoll - roll);
    fq.multiply(qPitch).multiply(qRoll);
    // (`compose` of the origin, `fq` and a unit scale: what `place` composed for a part at the origin.)
    frameMatrix.makeRotationFromQuaternion(fq);
    F[12] = x; F[13] = deck; F[14] = -y;
  };

  /** A point in the current frame (forward, up, left) to world (x, y) and height. */
  const toWorld = (along: number, up: number, side: number, out: { x: number; y: number; h: number }): void => {
    const z = -side;
    out.x = F[0] * along + F[4] * up + F[8] * z + F[12];
    out.h = F[1] * along + F[5] * up + F[9] * z + F[13];
    out.y = -(F[2] * along + F[6] * up + F[10] * z + F[14]);
  };
  const partPoint = { x: 0, y: 0, h: 0 };

  /** This frame's whole-level candidates' lengths on the screen (sorted natively, no comparator), and the least one may have (last frame's cap). */
  let nearCandidates = new Float64Array(VEHICLE_NEAR_CAP * 2);
  let nearCount = 0;
  let nearFloor = 0;
  /** Whether a two-wheeler was drawn whole last frame: then they all cast into the shadow map */
  let bikesWhole = false;
  let castersChanged = false;
  let casting = false;
  let suspensionClock = typeof performance !== 'undefined' ? performance.now() : 0;
  let suspensionDt = 0;
  /** The simulation's own time between two frames drawn (tick and interpolation) */
  let gaitClock = -1;
  let gaitDt = 0;
  let suspensionFrame = 0;

  /** The parts written this frame or drawn last frame: DO NOT walk every part of every body and level each frame (a thousand of them) to reset and send them. */
  const live: Part[] = [];
  /** The parked cars whose instances are kept (`Part.kept`), and the one being written now into the kept instances (null: this frame's). */
  const keptList: VehicleDraw[] = [];
  let recording: VehicleDraw | null = null;
  /** The vehicle being written is off the screen and only in the shadows' reach: only the parts that cast are written (`Part.casts`). */
  let castOnly = false;
  /** Pixels a metre where the vehicle being drawn stands (`screenScale`): its parts' levels (`vehicleLevels.ts`). */
  let drawPixels = Number.POSITIVE_INFINITY;

  /** Instances [from, to) of a part changed: sent at the end of the frame, with whatever the GPU has not taken yet. */
  const touch = (part: Part, from: number, to: number): void => {
    if (part.hi <= part.lo) { part.lo = from; part.hi = to; return; }
    if (from < part.lo) part.lo = from;
    if (to > part.hi) part.hi = to;
  };
  /** One instance moved within a part: its matrix, its tint, a lamp's glow. */
  const moveInstance = (part: Part, from: number, to: number): void => {
    const m = part.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0, a = from * 16, b = to * 16; i < 16; i++) m[b + i] = m[a + i]!;
    if (part.tinted) {
      const c = part.mesh.instanceColor!.array as Float32Array;
      c[to * 3] = c[from * 3]!; c[to * 3 + 1] = c[from * 3 + 1]!; c[to * 3 + 2] = c[from * 3 + 2]!;
    }
    if (part === lamps) { const g = lampGlow.array as Float32Array; g[to] = g[from]!; }
    touch(part, to, to + 1);
  };
  const listed = (part: Part): void => {
    if (part.listed) return;
    part.listed = true;
    live.push(part);
  };
  /** The next instance of the part: this frame's, or, while a parked car is written to be kept, one more of the kept ones (the frame's there moved to the end). */
  const slotOf = (part: Part): number => {
    if (part.n >= part.mesh.instanceMatrix.count) growPart(part, part.n + 1);
    listed(part);
    const holder = recording;
    if (!holder) return part.n++;
    const at = part.kept;
    if (part.n > at) moveInstance(part, at, part.n);
    part.holders.push(holder);
    part.holderAt.push(holder.keptSlots.length);
    holder.keptParts.push(part);
    holder.keptSlots.push(at);
    part.kept++;
    part.n++;
    touch(part, at, at + 1);
    return at;
  };
  /** The kept cars seen this frame (`seeKept`): none missing when it reaches `keptList.length`. */
  let keptSeenNow = 0;
  /** A kept car drawn this frame, counted once while it is kept. */
  const seeKept = (s: VehicleDraw): void => {
    if (s.keptSeen === suspensionFrame) return;
    s.keptSeen = suspensionFrame;
    if (s.keptAt >= 0) keptSeenNow++;
  };
  /** A parked car's kept instances let go: the last kept one of each part takes each one's place, and this frame's last the place it left. */
  const dropKept = (s: VehicleDraw): void => {
    const parts = s.keptParts, slots = s.keptSlots;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]!, at = slots[j]!, last = part.kept - 1;
      if (at !== last) {
        moveInstance(part, last, at);
        const holder = part.holders[last]!, k = part.holderAt[last]!;
        part.holders[at] = holder;
        part.holderAt[at] = k;
        holder.keptSlots[k] = at;
      }
      part.holders.pop();
      part.holderAt.pop();
      part.kept = last;
      const end = part.n - 1;
      if (end > last) moveInstance(part, end, last);
      part.n = end;
    }
    parts.length = 0;
    slots.length = 0;
    const tail = keptList.pop()!;
    if (tail !== s) { keptList[s.keptAt] = tail; tail.keptAt = s.keptAt; }
    s.keptAt = -1;
  };
  /** The tint (none: left white) and a lamp's glow of instance `at`. */
  const tintAt = (part: Part, at: number, tint: Tint | null): void => {
    if (tint) {
      const c = part.mesh.instanceColor!.array as Float32Array;
      c[at * 3] = tint.r; c[at * 3 + 1] = tint.g; c[at * 3 + 2] = tint.b;
      part.tinted = true;
    }
    if (part === lamps) (lampGlow.array as Float32Array)[at] = tint ? tint.glow : 0;
  };

  /** Writes one instance in the current vehicle's frame: the frame times the part's place, its turn (Euler y then z, `YXZ`) and its size, straight into the buffer. */
  const place = (
    part: Part,
    along: number,
    side: number,
    up: number,
    sx: number,
    sy: number,
    sz: number,
    tint: Tint | null,
    rake = 0,
    yaw = 0,
  ): void => {
    // The part's own turn, its columns scaled: `makeRotationFromEuler` (`YXZ`, no x) by hand.
    let a0 = sx, a1 = 0, a2 = 0, b0 = 0, b1 = sy, b2 = 0, c0 = 0, c2 = sz;
    if (rake !== 0 || yaw !== 0) {
      const cy = Math.cos(yaw), sY = Math.sin(yaw), cr = Math.cos(rake), sr = Math.sin(rake);
      a0 = cy * cr * sx; a1 = sr * sx; a2 = -sY * cr * sx;
      b0 = -cy * sr * sy; b1 = cr * sy; b2 = sY * sr * sy;
      c0 = sY * sz; c2 = cy * sz;
    }
    if (castOnly && !part.casts) return;
    const z = -side;
    const at = slotOf(part);
    const m = part.mesh.instanceMatrix.array as Float32Array, o = at * 16;
    m[o] = F[0] * a0 + F[4] * a1 + F[8] * a2; m[o + 1] = F[1] * a0 + F[5] * a1 + F[9] * a2; m[o + 2] = F[2] * a0 + F[6] * a1 + F[10] * a2; m[o + 3] = 0;
    m[o + 4] = F[0] * b0 + F[4] * b1 + F[8] * b2; m[o + 5] = F[1] * b0 + F[5] * b1 + F[9] * b2; m[o + 6] = F[2] * b0 + F[6] * b1 + F[10] * b2; m[o + 7] = 0;
    m[o + 8] = F[0] * c0 + F[8] * c2; m[o + 9] = F[1] * c0 + F[9] * c2; m[o + 10] = F[2] * c0 + F[10] * c2; m[o + 11] = 0;
    m[o + 12] = F[0] * along + F[4] * up + F[8] * z + F[12];
    m[o + 13] = F[1] * along + F[5] * up + F[9] * z + F[13];
    m[o + 14] = F[2] * along + F[6] * up + F[10] * z + F[14];
    m[o + 15] = 1;
    tintAt(part, at, tint);
  };
  /** A part that does not move on the vehicle (its body, glass, trim): the vehicle's own frame, copied. */
  const placeWhole = (part: Part, tint: Tint | null): void => {
    if (castOnly && !part.casts) return;
    const at = slotOf(part);
    const m = part.mesh.instanceMatrix.array as Float32Array, o = at * 16;
    for (let i = 0; i < 16; i++) m[o + i] = F[i]!;
    tintAt(part, at, tint);
  };
  /** DO NOT write `setMatrixAt` on a part anywhere else: a parked car's kept instances are only what passed through `slotOf`. */
  const write = (part: Part, matrix: Matrix4, tint: Tint | null): void => {
    if (castOnly && !part.casts) return;
    const at = slotOf(part);
    const m = part.mesh.instanceMatrix.array as Float32Array, o = at * 16, e = matrix.elements;
    for (let i = 0; i < 16; i++) m[o + i] = e[i]!;
    tintAt(part, at, tint);
  };
  /** The soft disc under a vehicle (`blobShadows.ts` blobInto). */
  const placeBlob = (x: number, y: number, deck: number, angle: number, radius: number, length: number): void => {
    if (castOnly) return;
    const at = slotOf(blobs);
    blobInto(blobs.mesh.instanceMatrix.array as Float32Array, at * 16, x, deck, -y, angle, radius, length);
  };
  /** DO NOT go back to dropping what passes the capacity: the town's parked cars past the fleet's ceiling were not drawn. */
  const growPart = (part: Part, needed: number): void => {
    const mesh = part.mesh;
    let capacity = Math.max(1, mesh.instanceMatrix.count);
    while (capacity < needed) capacity *= 2;
    const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    matrices.array.set(mesh.instanceMatrix.array);
    matrices.setUsage(DynamicDrawUsage);
    // DO NOT give a colour to a mesh made without one (the discs): another program, built during play.
    const colours = mesh.instanceColor ? new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3) : null;
    if (colours && mesh.instanceColor) { colours.array.set(mesh.instanceColor.array); colours.setUsage(DynamicDrawUsage); }
    // DO NOT `dispose` the mesh to let its old buffers go: three's releaseStatesOfObject walks every geometry the renderer knows (WebGLBindingStates), ms a call; the old buffers stay on the GPU till the context goes (less than the new one's size, a doubling at a time).
    mesh.instanceMatrix = matrices;
    mesh.instanceColor = colours;
    // A new buffer is sent whole the first time it is drawn.
    watchUploads(part);
    if (part === lamps) {
      const glow = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      glow.array.set(lampGlow.array);
      glow.setUsage(DynamicDrawUsage);
      unitBox.dispose();
      unitBox.setAttribute('glow', glow);
      lampGlow = glow;
    }
  };
  /** An attribute's instances [from, to) sent at the next draw (the ranges of three's `WebGLAttributes.updateBuffer`). */
  const send = (attribute: InstancedBufferAttribute, from: number, to: number, size: number): void => {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(from * size, (to - from) * size);
    attribute.needsUpdate = true;
  };

  /** Road wheels, plus their hubs at the closest band. */
  const placeWheels = (plan: BodyPlan, band: number): void => {
    const d = plan.wheelRadius * 2;
    // Each at the level its size on the screen allows: the unit tyre and rim scaled by the wheel (its largest scale).
    const wheels = rung(wheelLevels, levelFor(drawPixels * tyreSize(plan)));
    const hubs = rung(hubLevels, levelFor(drawPixels * rimSize(plan)));
    const axles = plan.axleAlong;
    for (let axle = 0; axle < axles.length; axle++) {
      const along = axles[axle]!;
      // Only the front axle steers; every hub turns with the distance driven
      const steer = axle === 0 ? lamp.steer : 0;
      if (plan.shape === 'bicycle') {
        place(thinWheels, along, 0, plan.wheelRadius, d, d, plan.tread, T_RUBBER, 0, steer);
        place(spokes, along, 0, plan.wheelRadius, d, d, plan.tread, T_CHROME, lamp.spin, steer);
        continue;
      }
      if (plan.axleSide === 0) {
        if (wheels) place(wheels, along, 0, plan.wheelRadius, d, d, plan.tread, T_RUBBER, 0, steer);
        if (band >= 1 && hubs) {
          place(hubs, along, 0, plan.wheelRadius, d * 0.45, d * 0.45, plan.tread * 1.1, T_HUB, lamp.spin, steer);
        }
        continue;
      }
      for (const side of SIDES) {
        if (wheels) place(wheels, along, side * plan.axleSide, plan.wheelRadius, d, d, plan.tread, T_RUBBER, 0, steer);
        if (band >= 1 && hubs) {
          place(
            hubs,
            along,
            side * (plan.axleSide + plan.tread * 0.3),
            plan.wheelRadius,
            d * 0.52,
            d * 0.52,
            plan.tread * 0.5,
            T_HUB,
            lamp.spin,
            steer,
          );
        }
      }
    }
  };

  /** A part that does not move on the vehicle (`drawCar`), at the level `detail` its size allows: the vehicle's own frame. */
  const wholeAt = (l: Ladder | null, detail: number, tint: Tint | null): void => {
    const part = l ? rung(l, detail) : null;
    if (part) placeWhole(part, tint);
  };
  /** A door's lowered window this frame (`windowPane`), written in place. */
  const pane = { visible: true, up: 0, sy: 1 };

  /** Hatchback, sedan, SUV and van, from the class's model (`vehicleModels.ts`) */
  const drawCar = (vehicle: SimVehicle, s: VehicleDraw, band: number): void => {
    const car = s.car;
    if (!car) return;
    const model = car.model;
    const paint = s.paintTint;
    if (band < 1) {
      // Far away: one opaque, low-poly body, glass and wheels painted on.
      placeWhole(car.far, paint);
      for (const l of model.taillamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.tail);
      return;
    }
    const look = s.look;
    const doorsMoving = vehicle.doors.length > 0;
    // The parts that do not move, each at the level whose error is under half a pixel at this car's size (`vehicleLevels.ts`).
    const detail = levelFor(drawPixels);
    // Real shadows from the whole vehicle only; the middle level's is a soft disc (`sync`).
    const shell = band >= 2 ? car.shell : car.shellLite;
    const doors = model.doors;
    if (!doorsMoving && look.windowsDown === 0) {
      wholeAt(shell, detail, paint);
      wholeAt(car.glass, detail, null);
    } else if (!doorsMoving) {
      // A window down: the fixed glazing, then each door's window, lowered into its door
      wholeAt(shell, detail, paint);
      placeWhole(car.openGlass, null);
      for (let i = 0; i < doors.length; i++) {
        const door = doors[i]!;
        const down = (look.windowsDown & (door.side === -1 ? 1 : 2)) !== 0 && door.kind === 'hinge';
        windowPane(door, down ? look.windowDrop : 0, pane);
        if (pane.visible) place(car.doorGlass[i]!, door.hingeX, -door.hingeZ, pane.up, 1, pane.sy, 1, null);
      }
    } else {
      placeWhole(car.openShell, paint);
      placeWhole(car.openGlass, null);
      for (let i = 0; i < doors.length; i++) {
        const door = doors[i]!;
        const open = doorOpening(vehicle, door.index);
        if (door.kind === 'slide') {
          // A plug door: out a little, then along the body.
          const out = Math.min(1, open * 4) * m(0.07);
          const along = door.hingeX + door.slide * smooth01((open - 0.15) / 0.85);
          const across = -(door.hingeZ + door.side * out);
          place(car.doors[i]!, along, across, 0, 1, 1, 1, paint);
          place(car.doorGlass[i]!, along, across, 0, 1, 1, 1, null);
          continue;
        }
        // Swung about the hinge, outwards on its own side.
        const swing = open * DOOR_SWING;
        place(car.doors[i]!, door.hingeX, -door.hingeZ, 0, 1, 1, 1, paint, 0, door.side * swing);
        place(car.doorGlass[i]!, door.hingeX, -door.hingeZ, 0, 1, 1, 1, null, 0, door.side * swing);
      }
    }
    const roof = band >= 2 ? car.roof : car.roofLite;
    const accent = band >= 2 ? car.accent : car.accentLite;
    if (roof && car.roofGlass) {
      if (look.glassRoof) placeWhole(car.roofGlass, null);
      else wholeAt(roof, detail, look.blackRoof ? T_BLACK_ROOF : paint);
    }
    wholeAt(accent, detail, s.accent);
    placeWheels(s.plan, band);

    wholeAt(car.trim, detail, null);
    for (const l of model.headlamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.head);
    for (const l of model.taillamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.tail);
    for (const l of model.indicators) {
      // `lamp.indicate` is +1 for left, and the model's left is -Z.
      if (lamp.indicate !== 0 && lamp.indicate === -l.side) {
        place(lamps, l.x, -l.z, l.y, l.sx * 1.2, l.sy, l.sz, T_INDICATOR);
      }
    }
    if (band < 2) return;
    if (!doorsMoving) wholeAt(car.interior, detail, null);
    else {
      placeWhole(car.openInterior, null);
      for (let i = 0; i < doors.length; i++) {
        const door = doors[i]!, card = car.doorCards[i];
        if (!card || door.kind !== 'hinge') continue;
        place(card, door.hingeX, -door.hingeZ, 0, 1, 1, 1, null, 0, door.side * doorOpening(vehicle, door.index) * DOOR_SWING);
      }
    }
    const plates = model.plates;
    for (let i = 0; i < plates.length; i++) { const l = plates[i]!; place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, i < 2 ? T_PLATE : T_DESTINATION); }
    placeCarOccupants(vehicle, car);
  };

  /** The company a vehicle's people are cast in (`citizenCasting.codesFor`). */
  const vehicleCompany = (vehicle: SimVehicle): Company =>
    vehicle.archetype.shape === 'bus' ? 'bus' : vehicle.archetype.shape === 'truck' ? 'truck'
      : vehicle.archetype.shape === 'motorcycle' || vehicle.archetype.shape === 'bicycle' ? 'rider' : 'car';
  /** Whether anybody aboard is a child: a car with a child in it is never on a work trip. */
  const carriesChild = (vehicle: SimVehicle): boolean => {
    const seats = Math.min(32, vehicle.archetype.seats);
    for (let i = 0; i < seats; i++) if ((vehicle.seats & (1 << i)) !== 0 && seatPerson(vehicle, i).ageClass === 'child') return true;
    return false;
  };
  /** The vehicles whose people were cast (`seatIdentity`), by id */
  const castVehicles = new Map<number, SimVehicle>();
  /** The people of a vehicle gone from the world let go by the casting, told by the client as it goes (DO NOT walk every vehicle cast at each change of the fleet). */
  const forgetGone = (vehicle: SimVehicle): void => {
    if (castVehicles.get(vehicle.id) !== vehicle) return;
    castVehicles.delete(vehicle.id);
    pedestrians.forgetCompany(vehicleCompany(vehicle), vehicle.id);
  };
  const forgetCast = (world: SimClient): void => {
    if (world.onVehicleGone !== forgetGone) world.onVehicleGone = forgetGone;
  };
  /** Who sits in (or steps out of) a seat: the seat's person, cast with the vehicle's company. */
  /** DO NOT make an identity for every seat drawn every frame: one, filled again (`drawClip` and `indexFor` read it in the call, keep nothing of it). */
  const seatWho: { -readonly [K in keyof ClipIdentity]-?: ClipIdentity[K] } = { seed: 0, gender: 'f', ageClass: 'adult', company: 'car', companyId: 0, hasChild: false };
  const seatIdentity = (vehicle: SimVehicle, person: { seed: number; gender: 'f' | 'm'; ageClass: 'child' | 'adult' | 'elder' },
    hasChild: boolean): ClipIdentity => {
    castVehicles.set(vehicle.id, vehicle);
    seatWho.seed = person.seed; seatWho.gender = person.gender; seatWho.ageClass = person.ageClass;
    seatWho.company = vehicleCompany(vehicle); seatWho.companyId = vehicle.id; seatWho.hasChild = hasChild;
    return seatWho;
  };

  /** The whole person in a seat: its world point, written without allocating. */
  const seatPoint: { x: number; y: number; h?: number } = { x: 0, y: 0, h: 0 };

  /** The people in a car, each in a seat of the model */
  const placeCarOccupants = (vehicle: SimVehicle, car: CarParts): void => {
    if (occupantBand < 1) return;
    const model = car.model;
    // Who is sitting where is the simulation's (`Vehicle.seats`)
    const moving = vehicle.kerbStop?.phase === 'transfer' ? vehicle.kerbStop.seat : -1;
    let driverScale = 0;
    // Only the seats the simulation can fill: `Vehicle.seats` is a 32-bit mask, and `1 << 32` is 1 again in JavaScript.
    const seatCount = Math.min(model.seats.length, vehicle.archetype.seats);
    const hasChild = carriesChild(vehicle);
    // A person picked up from the street already has a visible identity (two rounds, no list made a car).
    for (let round = 0; round < 2; round++) for (let index = 0; index < seatCount; index++) {
      if ((vehicle.seats & (1 << index)) === 0 || index === moving) continue;
      if ((vehicle.people[index] !== undefined) !== (round === 0)) continue;
      const seat = model.seats[index]!;
      if (seat.row > rowsDrawn) continue;
      seatWorldInto(seat, seatPoint, seat.hipY);
      const who = seatIdentity(vehicle, seatPerson(vehicle, index), hasChild);
      // The seat's pose (`riderPoses.ts`) with a glance now and then (`occupants.ts`).
      const slain = seat.driver && vehicle.slain === true;
      const plays = occupantPlays(seat, who.seed, frameClock, seatPlays, slain);
      const fixed = seat.pose === 'car' ? 0 : 1;
      const drawn = pedestrians.drawClip(who, seatPoint.x, seatPoint.y, seatPoint.h ?? fdeck + seat.hipY, fyaw, plays as readonly { key: CitizenClipKey; phase: number; weight: number }[],
        0, seatFitScale(seat), false, fixed, null, slain ? 'dead' : undefined);
      if (seat.driver) driverScale = drawn;
    }
    // The wheel where this driver's hands are: at their own size, and turned with the front wheels.
    if (car.steering && model.steering) {
      const seat = model.seats[model.steering.seat]!;
      const wheel = model.steering.wheel;
      const s = driverScale > 0 ? driverScale / m(1) : 1;
      placeSteeringWheel(car.steering, seat.x + m(wheel.forward) * s, -seat.z, seat.hipY + m(wheel.up) * s,
        wheel.tilt, Math.max(-1.6, Math.min(1.6, lamp.steer * 5)), s);
    }
    const stop = vehicle.kerbStop;
    if (stop) placeKerbPerson(vehicle, model, stop);
  };

  /** Reused by every seated person: what they play this frame. */
  const seatPlays: Play[] = [];
  /** Seconds of simulation, for the occupants' own motion; set per vehicle. */
  let frameClock = 0;
  /** Seat rows drawn this frame (`SeatModel.row`); set per sync from the zoom. */
  let rowsDrawn = Infinity;

  /** A steering wheel about its column: yaw with the vehicle, tilt, then the turn. */
  const placeSteeringWheel = (part: Part, along: number, side: number, up: number, tilt: number, turn: number, size = 1): void => {
    toWorld(along, up, side, partPoint);
    object.position.set(partPoint.x, partPoint.h, -partPoint.y);
    eulerScratch.rotation.order = 'YZX';
    eulerScratch.rotation.set(turn, 0, tilt);
    qLocal.setFromEuler(eulerScratch.rotation);
    eulerScratch.rotation.order = 'YXZ';
    object.quaternion.copy(fq).multiply(qLocal);
    // The rim at the driver's size too, so the hands on it are on it.
    object.scale.set(size, size, size);
    object.updateMatrix();
    // Through `write`, so a parked car's kept instances keep its wheel.
    write(part, object.matrix, null);
  };

  const seatWorld = (seat: { x: number; z: number }): { x: number; y: number } =>
    ({ x: fx + fdx * seat.x + fdy * seat.z, y: fy + fdy * seat.x - fdx * seat.z });
  /** A seat (X forward, Z to the right, `up` above the road) to world, through the vehicle's transform */
  const seatWorldInto = (seat: { x: number; z: number }, out: { x: number; y: number; h?: number }, up = 0): void => {
    toWorld(seat.x, up, -seat.z, partPoint);
    out.x = partPoint.x;
    out.y = partPoint.y;
    out.h = partPoint.h;
  };

  /** Somebody at the kerb this frame (`occupants.kerbFigure`), reused. */
  const kerb = createKerbFigure();
  /** A world point in the current vehicle's frame: X forward, Z to the right. */
  const toVehicle = (x: number, y: number): { x: number; z: number } => {
    const dx = x - fx;
    const dy = y - fy;
    return { x: dx * fdx + dy * fdy, z: dx * fdy - dy * fdx };
  };

  /** Somebody getting out at the kerb, or in. */
  const placeKerbPerson = (vehicle: SimVehicle, model: VehicleModel, stop: KerbStop): void => {
    const progress = kerbTransfer(stop);
    const person = stop.person;
    const door = model.doors.find((d) => d.index === stop.door);
    if (!progress || !person || !door) return;
    const side = door.side;
    const along = door.hingeX - door.length / 2;
    const flank = Math.abs(door.hingeZ);
    const seat = stop.seatStage ? model.seats[stop.seat] : undefined;
    const identity = seatIdentity(vehicle, person, carriesChild(vehicle));
    if (seat && door.kind === 'hinge' && !(progress.walked >= 1 && (stop.phase === 'hold' || stop.phase === 'close'))) {
      const f = kerbFigure({ seat, door, foot: toVehicle(person.footX, person.footY) }, stop.kind, progress.seated, progress.walked, kerb);
      seatWorldInto(f, seatPoint, f.y);
      pedestrians.drawClip(identity, seatPoint.x, seatPoint.y, seatPoint.h ?? fdeck + f.y, fyaw + f.heading, f.plays,
        0, f.seated ? seatFitScale(seat) : Infinity, f.anchor === 'pelvis' ? false : f.anchor === 'feet' ? true : 'pelvisOver');
      return;
    }
    // Just outside the door opening on the road, and just inside it.
    const outside = seatWorld({ x: along, z: side * (flank + m(0.45)) });
    const inside = seatWorld({ x: along, z: side * (flank - m(0.4)) });
    const walkTo = (fromX: number, fromY: number, toX: number, toY: number, t: number, height: number): void => {
      const x = fromX + (toX - fromX) * t;
      const y = fromY + (toY - fromY) * t;
      const distance = hypot2(toX - fromX, toY - fromY);
      const heading = Math.atan2(toY - fromY, toX - fromX);
      pedestrians.drawClip(identity, x, y, height, heading,
        [{ key: 'walk', phase: 0, distance: distance * t, weight: 1 }], 0, Infinity, true);
    };
    if (progress.walked >= 1 && (stop.phase === 'hold' || stop.phase === 'close')) {
      // Standing on the footway: the truck's mate with the load, facing the truck.
      pedestrians.drawClip(identity, person.footX, person.footY, fdeck,
        Math.atan2(outside.y - person.footY, outside.x - person.footX),
        [{ key: 'idle', phase: (stop.t * 0.1) % 1, weight: 1 }], 0, Infinity, true);
      return;
    }
    if (progress.walked > 0 || progress.seated <= 0) {
      // Between the door and the footway.
      if (stop.kind === 'drop') walkTo(outside.x, outside.y, person.footX, person.footY, progress.walked, fdeck);
      else walkTo(person.footX, person.footY, outside.x, outside.y, 1 - progress.walked, fdeck);
      return;
    }
    // A bus: stepping up through the door, then gone inside.
    const t = stop.kind === 'drop' ? 1 - progress.seated : progress.seated;
    if (stop.kind === 'pick' && t > 0.9) return;
    walkTo(outside.x, outside.y, inside.x, inside.y, stop.kind === 'pick' ? t : 1 - t, fdeck + m(0.25) * t);
  };

  /** A motorcycle or a bicycle from its model */
  const drawTwoWheeler = (vehicle: SimVehicle, s: VehicleDraw, band: number): void => {
    const bike = s.bike;
    if (!bike) return;
    const model = bike.model;
    const detail = levelFor(drawPixels);
    wholeAt(bike.body, detail, s.paintTint);
    const steering = rung(bike.steering, detail);
    if (steering) place(steering, model.headX, 0, model.headY, 1, 1, 1, T_CHROME, 0, lamp.steer);
    placeWheels(s.plan, band);
    if (band < 1) return;
    wholeAt(bike.trim, detail, T_TRIM);
    const cranks = bike.cranks ? rung(bike.cranks, detail) : null;
    if (cranks) place(cranks, model.bracketX, 0, model.bracketY, 1, 1, 1, T_CHROME, -lamp.crank);
    const h = model.headlamp;
    place(lamps, h.x, 0, h.y, h.sx, h.sy, h.sz, T_HEADLAMP, 0, lamp.steer);
    const t = model.taillamp;
    place(lamps, t.x, 0, t.y, t.sx, t.sy, t.sz, lamp.tail);
    placeRiderFigure(vehicle, model, s.plan.shape === 'bicycle', s);
  };

  /** What a rider plays this frame: the same few plays filled in again for every rider, none made a frame. */
  const riderPlays: { key: CitizenClipKey; phase: number; weight: number }[] = [];
  const riderPool = [0, 1, 2, 3].map(() => ({ key: 'bikeStop' as CitizenClipKey, phase: 0, weight: 0 }));
  const riderPlay = (key: CitizenClipKey, phase: number, weight: number): void => {
    const play = riderPool[riderPlays.length]!;
    play.key = key;
    play.phase = phase;
    play.weight = weight;
    riderPlays.push(play);
  };

  /** The person astride: a baked IK pose */
  const placeRiderFigure = (vehicle: SimVehicle, model: TwoWheelerModel, cyclist: boolean, s: VehicleDraw): void => {
    if (occupantBand < 1) return;
    const pelvisUp = model.seatY;
    // The seat point rolled about the road-level forward axis (`place`).
    const sideOffset = pelvisUp * fsin;
    const x = fx + fdx * model.seatX - fdy * sideOffset;
    const y = fy + fdy * model.seatX + fdx * sideOffset;
    const height = fdeck + pelvisUp * fcos;
    const moving = riderMoving(vehicle);
    const steer = Math.max(-1, Math.min(1, lamp.steer / STEER_FULL));
    riderPlays.length = 0;
    if (cyclist) {
      const phase = (-lamp.crank - Math.PI) / (2 * Math.PI);
      riderPlay('bikePedal', phase, moving * (1 - Math.abs(steer) * 0.4));
      if (steer > 0) riderPlay('bikeLeft', 0, moving * steer * 0.4);
      if (steer < 0) riderPlay('bikeRight', 0, moving * -steer * 0.4);
      riderPlay('bikeStop', 0, 1 - moving);
    } else {
      riderPlay('motoRide', 0, moving * (1 - Math.abs(steer)));
      if (steer > 0) riderPlay('motoLeft', 0, moving * steer);
      if (steer < 0) riderPlay('motoRight', 0, moving * -steer);
      riderPlay('motoStop', 0, 1 - moving);
    }
    // At the size the pose was solved at: the hands are on the grips and the feet on the pegs or pedals only there.
    const drawn = pedestrians.drawClip(seatIdentity(vehicle, seatPerson(vehicle, 0), false), x, y, height, fyaw, riderPlays, froll, Infinity, false, 1,
      cyclist ? null : helmetMatrix);
    if (!cyclist && drawn > 0) {
      // A motorcyclist's helmet, fitted to this body's head (`riderPoses.helmetShape`) and put where the pose just drawn has it.
      write(helmets, helmetMatrix, s.helmet);
    }
  };

  /** The helmet of the rider just drawn (`drawClip`). */
  const helmetMatrix = new Matrix4();

  /** Refreshed for every vehicle, read by whichever body builder runs. */
  const lamp: LampState = { head: T_HEADLAMP, tail: T_TAILLAMP, indicate: 0, steer: 0, spin: 0, crank: 0 };
  // One elevation callback for every vehicle and pedestrian drawn this frame.
  let currentSegment: SegmentId | undefined;
  const elevationOnCurrent = (x: number, y: number): number => elevationAt(x, y, currentSegment);
  /** DO NOT ask the diary per car (`touches`): every car read every entry since its serial, cars x entries a frame */
  let offRoadSweep: ChangeSweep | null = null;
  let offRoadSerial = 0;
  /** The serial the sweep stood at the frame before: only a car asked then is answered by the sweep's cells (`ChangeSweep.touches`). */
  let offRoadBefore = 0;
  /** Whether the ground last asked for `s` still holds where it stands (on its segment, or off the road): nothing of the diary since touched it. */
  /** DO NOT key it by position alone: a parked car kept the height it was first asked at and floated over (kept for the view it was asked for, `drawOf`). */
  const deckHolds = (s: VehicleDraw, v: SimVehicle, x: number, y: number): boolean => {
    if (!s.deckKnown || s.deckX !== x || s.deckY !== y || s.deckSegment !== (v.free ? undefined : v.segment)) return false;
    if (s.deckSeen >= offRoadSerial) return true;
    // DO NOT ask the diary for a car not asked the frame before: every entry since and every rectangle of each (`journal.touches`) costs more than its ground.
    if (s.deckSeen === offRoadBefore && !offRoadSweep!.touches(s.deckSeen, x, y)) {
      s.deckSeen = offRoadSerial;
      return true;
    }
    return false;
  };
  /** The ground under a vehicle: its lot or the land off the road, its segment's deck on it; asked again only where it moved or the diary touched it (DO NOT ask a car stopped at a light its deck every frame). */
  const standingDeck = (s: VehicleDraw, v: SimVehicle, x: number, y: number): number => {
    if (deckHolds(s, v, x, y)) return s.deckValue;
    const segment = v.free ? undefined : v.segment;
    const lot = v.free?.lot ?? null;
    const onLot = lot !== null && lotAt ? lotAt(lot, x, y) : NaN;
    const deck = Number.isFinite(onLot) ? onLot : elevationAt(x, y, segment);
    s.deckKnown = true; s.deckX = x; s.deckY = y; s.deckSegment = segment; s.deckValue = deck; s.deckSeen = offRoadSerial;
    return deck;
  };

  /** DO NOT look a vehicle up in a map for each thing drawn (its ride, its look, its parked copy, its body by a joined string, its paint by its CSS): one record by id holds them, refreshed when they change. */
  interface VehicleDraw extends KeptHolder, LeanState {
    /** The view it was last drawn for: another view of the same id asks its lean and its ground again. */
    view: SimVehicle | null;
    archetype: Archetype | null;
    plan: BodyPlan;
    car: CarParts | null;
    bike: TwoWheelerParts | null;
    /** `vehicleLook`, a pure function of the id and the seat count, and its two tints. */
    look: VehicleLook;
    lookSeats: number;
    accent: Tint;
    helmet: Tint;
    color: string | null;
    paint: number;
    paintTint: Tint;
    /** Suspension: the frame eases towards the road, never snaps; and the level it was drawn at (-1: none yet). */
    rideSet: boolean;
    deck: number;
    pitch: number;
    roll: number;
    lod: number;
    /** The frame it was last drawn in. */
    seen: number;
    /** The ground under it off the road (`offRoadDeck`): where it was asked and the diary's serial then. */
    deckKnown: boolean;
    deckX: number;
    deckY: number;
    deckValue: number;
    deckSeen: number;
    deckSegment: SegmentId | undefined;
    /** Standing still in its bay: its place in `keptList` (-1: none), the frame it was last drawn kept, its kept instances and what they were written for. */
    keptAt: number;
    keptSeen: number;
    readonly keptParts: Part[];
    keptX: number;
    keptY: number;
    keptAngle: number;
    keptDeck: number;
    keptBand: number;
    keptLevels: number;
    keptVersion: number;
    keptPaint: number;
    keptShadows: boolean;
    keptCastOnly: boolean;
    /** Kept as a parked car (lamps off) or as one stopped in the traffic. */
    keptParked: boolean;
    /** The deck last asked for it and where (`sync`'s cull): a later frame tests the view with it, grown by the most it can have climbed since. */
    cullKnown: boolean;
    cullX: number;
    cullY: number;
    cullDeck: number;
  }
  const T_WHITE = tintOf(0xffffff);
  const BLANK_LOOK = vehicleLook(0, 1);
  const draws = new Map<number, VehicleDraw>();
  /** The vehicles asked of the client's grid for this frame's view (`SimClient.vehiclesIn`), reused. */
  const inView: SimVehicle[] = [];
  const drawOf = (vehicle: SimVehicle): VehicleDraw => {
    let s = draws.get(vehicle.id);
    if (!s) {
      s = {
        keptSlots: [], leanKnown: false, lean: 0, leanAge: 0, view: null, archetype: null, plan: FALLBACK_PLAN, car: null, bike: null,
        look: BLANK_LOOK, lookSeats: -1, accent: T_WHITE, helmet: T_WHITE, color: null, paint: 0, paintTint: T_WHITE,
        rideSet: false, deck: 0, pitch: 0, roll: 0, lod: -1, seen: 0, deckKnown: false, deckX: 0, deckY: 0, deckValue: 0, deckSeen: 0, deckSegment: undefined,
        keptAt: -1, keptSeen: -1, keptParts: [], keptX: 0, keptY: 0, keptAngle: 0, keptDeck: 0, keptBand: 0, keptLevels: 0, keptVersion: 0,
        keptPaint: 0, keptShadows: false, keptCastOnly: false, keptParked: false, cullKnown: false, cullX: 0, cullY: 0, cullDeck: 0,
      };
      draws.set(vehicle.id, s);
    }
    if (s.view !== vehicle) { s.view = vehicle; s.deckKnown = false; s.leanKnown = false; s.cullKnown = false; }
    const a = vehicle.archetype;
    if (s.archetype !== a) {
      s.archetype = a;
      s.plan = planOf(a);
      s.car = a.shape === 'car' || a.shape === 'bus' || a.shape === 'truck' ? carParts.get(bodyKey(vehicle)) ?? null : null;
      s.bike = a.shape === 'motorcycle' || a.shape === 'bicycle' ? twoWheelerParts.get(a.id) ?? null : null;
      if (s.lookSeats !== s.plan.seats) {
        s.lookSeats = s.plan.seats;
        s.look = vehicleLook(vehicle.id, s.lookSeats);
        s.accent = tintOf(s.look.accent);
        s.helmet = tintOf(s.look.helmet);
      }
    }
    if (s.color !== vehicle.color) {
      s.color = vehicle.color;
      s.paint = hexOf(vehicle.color);
      s.paintTint = tintOf(s.paint);
    }
    return s;
  };

  /** What a cell of parked cars drew (`sync`): its version then, whether every car of it drawn stood as kept, those kept, each whole candidate's pixels and the cap's answer, whether one had wheels. */
  interface CellRecord {
    version: number;
    /** The lowest and highest deck its cars were tested at (`cullDeck`), whether every car's was known, and the diary's serial then. */
    lo: number;
    hi: number;
    bounded: boolean;
    serial: number;
    still: boolean;
    readonly kept: VehicleDraw[];
    readonly pixels: number[];
    readonly whole: boolean[];
    wheeled: boolean;
    /** Kept whole in a moving view (`vehicleInside`): the cars it had, every one drawn kept and on screen, the screen scales all of them keep their levels over, where they stand and their largest sphere; and what else their levels were chosen by. */
    count: number;
    onScreen: boolean;
    rangeLo: number;
    rangeHi: number;
    x0: number; y0: number; x1: number; y1: number;
    radius: number;
    band: number; ratio: number; nearCap: number; shadows: boolean; occupant: number; levels: number;
  }
  /** What a standing car's levels hold over (`standingRange`), reused. */
  const range = { lo: 0, hi: 0 };
  /** One over the screen's scale as a function of the place (`screenScale` goes as one over the depth, an affine function of the place; constant in an orthographic view): [at the origin, slope along x, y, z], found once a frame. */
  const field = Object.assign([0, 0, 0, 0], { valid: false });
  let fieldFrame = -1;
  const depthField = (scale: (x: number, y: number, z: number) => number, box: Readonly<GroundBox>): typeof field => {
    if (fieldFrame === suspensionFrame) return field;
    fieldFrame = suspensionFrame;
    const step = FLEET_CELL;
    const inv0 = 1 / scale(box.x0, box.y0, 0);
    field[1] = (1 / scale(box.x0 + step, box.y0, 0) - inv0) / step;
    field[2] = (1 / scale(box.x0, box.y0 + step, 0) - inv0) / step;
    field[3] = (1 / scale(box.x0, box.y0, step) - inv0) / step;
    field[0] = inv0 - field[1] * box.x0 - field[2] * box.y0;
    // DO NOT trust it untold: checked at the box's far corner; a scale of another form (or a corner behind the eye) walks every cell.
    const fx = box.x1, fy = box.y1, fz = step / 2;
    const predicted = field[0] + field[1] * fx + field[2] * fy + field[3] * fz;
    const measured = 1 / scale(fx, fy, fz);
    field.valid = Number.isFinite(predicted) && Number.isFinite(inv0) && inv0 > 0 && Math.abs(predicted - measured) <= FIELD_SLACK * Math.abs(measured);
    return field;
  };
  const cellsDrawn = new Map<number, CellRecord>();
  const cellsSeen = new Set<number>();
  const cellsIn: FleetCell<SimVehicle>[] = [];
  /** The view a frame was drawn for: a cell is kept only in a frame that stands as the last. */
  const viewKey = { x0: NaN, y0: NaN, x1: NaN, y1: NaN, zoom: NaN, probe: NaN, ex: NaN, ey: NaN, ez: NaN, ratio: NaN, shadows: false, occupant: NaN, detailed: false, serial: NaN, levels: NaN };

  return {
    meshes,
    get castersChanged() { return castersChanged; },
    get casting() { return casting; },
    get held() { return { vehicles: draws.size, cells: cellsDrawn.size, kept: keptList.length, people: procPeople.size }; },
    census: () => pedestrians.census(),
    meshProbe() {
      const out: { id: number; stretch: number; stretchBone: string; scale: number; scaleBone: string; held: boolean; clip: string }[] = [];
      if (!procedural) return out;
      const inv = new Matrix4();
      for (const [id, entry] of procPeople) {
        const person = entry.person;
        if (!person) continue;
        const pal = procedural.ragdoll.pose(person);
        const sk = procedural.ragdoll.skeleton(person);
        if (!pal || !sk) continue;
        // At this person's own joints (`skeleton` gives the binds moved to them).
        const bind = sk.inverses.map((m4) => { const e = inv.copy(m4).invert().elements; return [e[12]!, e[13]!, e[14]!] as const; });
        // Measured against the same person standing (their own proportions, `refit`)
        const rest = procedural.ragdoll.standing(person, 0);
        if (!rest) continue;
        const atIn = (m: Float32Array, b: number): [number, number, number] => {
          const o = b * 16, [x, y, z] = bind[b]!;
          return [m[o]! * x + m[o + 4]! * y + m[o + 8]! * z + m[o + 12]!, m[o + 1]! * x + m[o + 5]! * y + m[o + 9]! * z + m[o + 13]!,
            m[o + 2]! * x + m[o + 6]! * y + m[o + 10]! * z + m[o + 14]!];
        };
        const at = (b: number): [number, number, number] => atIn(pal, b);
        const norm = (b: number): number => Math.max(Math.hypot(pal[b * 16]!, pal[b * 16 + 1]!, pal[b * 16 + 2]!),
          Math.hypot(pal[b * 16 + 4]!, pal[b * 16 + 5]!, pal[b * 16 + 6]!), Math.hypot(pal[b * 16 + 8]!, pal[b * 16 + 9]!, pal[b * 16 + 10]!));
        let stretch = 1, stretchBone = '', scale = 0, scaleBone = '';
        let longest = 0;
        for (let b = 0; b < sk.parents.length; b++) {
          const p = sk.parents[b]!;
          if (p >= 0) longest = Math.max(longest, Math.hypot(bind[b]![0] - bind[p]![0], bind[b]![1] - bind[p]![1], bind[b]![2] - bind[p]![2]));
        }
        for (let b = 0; b < sk.parents.length; b++) {
          const name = sk.names[b] ?? '';
          if (/Finger|Toe|Nub|_end|twist/i.test(name)) continue;
          const n = norm(b);
          if (n > scale) { scale = n; scaleBone = name; }
          const p = sk.parents[b]!;
          // Not against the root (it stays at the feet: a crouch lowers the pelvis to it, no skin between).
          if (p < 0 || sk.parents[p]! < 0 || n < 0.5 || norm(p) < 0.5) continue;
          const ra = atIn(rest, b), rc = atIn(rest, p);
          const l0 = Math.hypot(ra[0] - rc[0], ra[1] - rc[1], ra[2] - rc[2]);
          // Bones of real length only: a few millimetres between the spine and the pelvis made a 3x from nothing.
          if (l0 < longest * 0.12) continue;
          const a = at(b), c = at(p);
          const r = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) / l0;
          if (Math.abs(r - 1) > Math.abs(stretch - 1)) { stretch = r; stretchBone = `${name}<${sk.names[p]} ${(l0 * 100).toFixed(1)}cm ${person.sex}-${person.band}`; }
        }
        out.push({ id, stretch, stretchBone, scale, scaleBone, held: procHeld.has(id), clip: person.clip });
      }
      return out;
    },
    animProbe(id) {
      const person = procPeople.get(id)?.person;
      if (!person || !procedural) return null;
      const duration = procedural.ragdoll.duration(person, person.clip);
      const held = procHeld.has(id);
      return {
        clip: person.clip, time: (person.phase - Math.floor(person.phase)) * duration, duration, weight: held ? 0 : 1,
        paused: procFrozen.has(id), layers: procedural.ragdoll.layers(person), source: held ? 'physics' : 'animation',
      };
    },
    forceClip(id, clip) {
      if (clip) procForced.set(id, clip); else procForced.delete(id);
    },
    driverBody(vehicle, x, y) {
      return pedestrians.indexFor(seatIdentity(vehicle, seatPerson(vehicle, 0), false), vehicle.archetype.shape === 'motorcycle', x, y);
    },
    carcass(vehicle, intact = false) {
      const a = vehicle.archetype;
      const plan = planOf(a);
      const pieces: BufferGeometry[] = [];
      const put = (g: BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void => {
        pieces.push(g.clone().scale(sx, sy, sz).translate(x, y, z));
      };
      const d = plan.wheelRadius * 2;
      if (a.shape === 'motorcycle' || a.shape === 'bicycle') {
        const t = twoWheelerParts.get(a.id);
        if (!t) return null;
        const md = t.model;
        put(md.body, 0, 0, 0); put(md.trim, 0, 0, 0); put(md.steering, md.headX, md.headY, 0);
        if (md.cranks) put(md.cranks, md.bracketX, md.bracketY, 0);
        // The tyres burnt away: the rims left, sagging to the ground (whole, on a machine merely dropped).
        for (const along of plan.axleAlong) {
          if (intact) {
            put(a.shape === 'bicycle' ? thinTyreGeometry : wheelGeometry, along, plan.wheelRadius, 0, d, d, plan.tread);
            put(a.shape === 'bicycle' ? spokedGeometry : hubGeometry, along, plan.wheelRadius, 0, d * (a.shape === 'bicycle' ? 1 : 0.45), d * (a.shape === 'bicycle' ? 1 : 0.45), plan.tread);
          } else if (a.shape === 'bicycle') put(spokedGeometry, along, plan.wheelRadius * 0.93, 0, d * 0.95, d * 0.95, plan.tread);
          else put(hubGeometry, along, plan.wheelRadius * 0.75, 0, d * 0.72, d * 0.72, plan.tread);
        }
      } else {
        const car = carParts.get(bodyKey(vehicle as SimVehicle));
        if (!car) return null;
        const md = car.model;
        put(md.shell, 0, 0, 0); put(md.trim, 0, 0, 0); put(md.interior, 0, 0, 0);
        if (md.accent) put(md.accent, 0, 0, 0);
        if (md.roof) put(md.roof, 0, 0, 0);
        for (const along of plan.axleAlong) {
          for (const side of plan.axleSide === 0 ? [0] : SIDES) {
            put(hubGeometry, along, plan.wheelRadius * 0.72, -side * plan.axleSide, d * 0.62, d * 0.62, plan.tread * 0.6);
          }
        }
      }
      const welded = merge(pieces);
      // A wreck is drawn faceted (a loose triangle list's `computeVertexNormals`), as before `merge` was indexed: one geometry a wreck
      const merged = welded.toNonIndexed();
      welded.dispose();
      // Each wreck its own: the panels buckled and the roof sagged by the heat and the blast, by a pattern of its own (its id).
      merged.computeBoundingBox();
      const box = merged.boundingBox!;
      const centre = box.getCenter(new Vector3());
      merged.translate(-centre.x, -centre.y, -centre.z);
      if (intact) { merged.computeVertexNormals(); return merged; }
      const pos = merged.getAttribute('position');
      const seed = (vehicle.id * 2654435761) >>> 0;
      const wave = (x: number, y: number, z: number, k: number): number => Math.sin(x * k + (seed % 97)) * Math.cos(z * k * 1.3 + (seed % 61)) + Math.sin(y * k * 0.7 + (seed % 13));
      const half = (box.max.y - box.min.y) / 2;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const top = Math.max(0, y / Math.max(1e-6, half));
        const dent = wave(x, y, z, 1 / m(0.45)) * m(0.04) + wave(x, y, z, 1 / m(0.18)) * m(0.015);
        pos.setXYZ(i, x + dent * 0.5, y - top * top * m(0.12) + dent, z + dent * 0.6);
      }
      merged.computeVertexNormals();
      return merged;
    },
    setBleed: (fn) => { pedestrians.onBleed = fn; procBleed = fn; },
    setNight: (dark) => {
      lampDark.value = dark;
    },
    renderPalettes(renderer) { procedural?.renderPalettes(renderer); pedestrians.renderPalettes(renderer); },
    sync(world, net, alpha, detailed, zoom = Number.POSITIVE_INFINITY, options = {}) {
      // A new document has a journal of its own: the sweep follows the one the world stands on.
      if (offRoadSweep?.journal !== net.doc.changes) offRoadSweep = new ChangeSweep(net.doc.changes, OFF_ROAD_GROUND);
      offRoadBefore = offRoadSerial;
      offRoadSweep.advance();
      offRoadSerial = offRoadSweep.serial;
      const now = typeof performance !== 'undefined' ? performance.now() : suspensionClock + 16;
      suspensionDt = Math.min(0.1, Math.max(0, (now - suspensionClock) / 1000));
      suspensionClock = now;
      const simNow = world.time + alpha * DT;
      gaitDt = gaitClock < 0 ? 0 : Math.min(0.5, Math.max(0, simNow - gaitClock));
      gaitClock = simNow;
      suspensionFrame++;
      // A vehicle not drawn for two seconds: its record let go (a kept one's instances went the frame it was not drawn).
      if (suspensionFrame % 600 === 0) for (const [id, s] of draws) if (suspensionFrame - s.seen > 120 && s.keptAt < 0) draws.delete(id);
      forgetCast(world);
      pedestrians.begin(options.pedestrianDetail ?? 2, zoom, options.personPixels ?? null, options.pixelRatio ?? 1);
      procPixels = options.personPixels ?? null;
      // This frame's instances start after the parked cars' kept ones.
      for (const part of live) part.n = part.kept;
      const band = !detailed ? 0 : zoom >= NEAR_DETAIL_ZOOM ? 2 : 1;
      // Vehicles have their own bands: the far proxy below FAR_BODY_ZOOM, the whole body above it
      const occupantZoom = options.occupantZoom ?? OCCUPANT_ZOOM;
      const vehicleBand = !detailed || zoom < FAR_BODY_ZOOM ? 0 : zoom >= occupantZoom ? 2 : 1;
      // Between the occupant zoom and 1.6 times it, only the front row.
      rowsDrawn = zoom >= occupantZoom * 1.6 ? Infinity : 0;

      const screenScale = options.screenScale;
      const pixelRatio = options.pixelRatio ?? 1;
      // A part's level by its error in pixels drawn, against the tier's pixels (`levelFor` is against `ERROR_PIXELS`): one where the tier draws as every tier did.
      const levelRatio = pixelRatio * (ERROR_PIXELS / (options.tier?.vehicleErrorPixels ?? ERROR_PIXELS));
      const nearCap = options.tier?.vehicleWholeCap ?? VEHICLE_NEAR_CAP;
      const softShadows = options.shadows !== false;
      let whole = 0;
      nearCount = 0;
      // Last frame's answer: this frame's discs and casting agree with each other.
      const bikesCast = bikesWhole;
      let bikesWholeNow = false, carsWheeled = false;
      // The traffic, then the scenery's cars parked in their bays, on the ground of the lot: DO NOT walk the whole fleet, only those standing on the view's ground.
      /** Whole or not by the cap (`VEHICLE_NEAR_CAP`, the biggest on the screen, last frame's floor): 2 or 1. */
      const wholeOrNot = (pixels: number): number => {
        if (nearCount === nearCandidates.length) { const grown = new Float64Array(nearCount * 2); grown.set(nearCandidates); nearCandidates = grown; }
        nearCandidates[nearCount++] = pixels;
        if (pixels < nearFloor || whole >= nearCap) return 1;
        whole++;
        return 2;
      };
      /** The cell being walked (null: the traffic): what it drew, to be kept as it is while nothing of it nor of the view changes. */
      let cellRecord: CellRecord | null = null;
      keptSeenNow = 0;
      fieldFrame = -1;
      /** A car of `record` drawn standing: the scales its levels hold over narrow the cell's, its place and sphere grow the cell's. */
      // Only where a cell can be kept whole in a moving view (`vehicleInside`): DO NOT work out each car's range for nothing.
      const keepsCells = !!options.vehicleInside && !!screenScale;
      const standsIn = (record: CellRecord, plan: BodyPlan, own: number, pixels: number, onScreen: boolean, x: number, y: number, radius: number): void => {
        if (!keepsCells) return;
        standingRange(plan, own, pixels, levelRatio, occupantZoom, range);
        if (range.lo > record.rangeLo) record.rangeLo = range.lo;
        if (range.hi < record.rangeHi) record.rangeHi = range.hi;
        if (!onScreen) record.onScreen = false;
        if (x < record.x0) record.x0 = x;
        if (x > record.x1) record.x1 = x;
        if (y < record.y0) record.y0 = y;
        if (y > record.y1) record.y1 = y;
        if (radius > record.radius) record.radius = radius;
      };
      const drawVehicle = (vehicle: SimVehicle): void => {
        const s = drawOf(vehicle);
        // Off the road and not moving (the town's parked cars): where it is, with none of the interpolation's sums.
        const at = vehicle.free;
        const pose = POSE;
        if (at && at.px === at.x && at.py === at.y && at.pangle === at.angle) { pose.p.x = at.x; pose.p.y = at.y; pose.angle = at.angle; }
        else framesPoseInto(vehicle.frames, alpha, pose);
        const free = vehicle.free !== null;
        const plan = s.plan;
        const twoWheeled = plan.shape === 'motorcycle' || plan.shape === 'bicycle';
        const reach = plan.length * 0.5 + plan.height * 2;
        const seen = plan.length * 0.6 + plan.height * 0.5;
        const visible = options.vehicleVisible;
        // On screen; else off it but in the shadows' reach: only what casts is written (no glass, cabin, trim, lamps or disc); else nothing of it this frame.
        // DO NOT test the reach of one on screen: its sphere holds the screen's (centres 0.3 of the radii apart), one test.
        let onScreen = true;
        /** Whether this frame's tests were made already, at the deck last asked (it stands where it was asked). */
        let tested = false;
        // DO NOT ask the ground of a vehicle off the view: tested first with the deck last asked, the sphere grown to hold every deck it can have reached since.
        if (visible && s.cullKnown) {
          const moved = hypot2(pose.p.x - s.cullX, pose.p.y - s.cullY);
          if (moved === 0) {
            // Standing where it was asked: the tests at that deck are this frame's while its ground holds.
            tested = true;
            if (!(reach >= seen && visible(pose.p.x, pose.p.y, s.cullDeck, seen))) {
              if (!visible(pose.p.x, pose.p.y, s.cullDeck, reach)) return;
              onScreen = reach >= seen ? false : visible(pose.p.x, pose.p.y, s.cullDeck, seen);
            }
          } else if (moved < CULL_REUSE && !visible(pose.p.x, pose.p.y, s.cullDeck, reach + CULL_GROWTH * moved * CULL_GRADE)) return;
        }
        const deck = standingDeck(s, vehicle, pose.p.x, pose.p.y);
        // Its ground changed under it: tested again on the new one.
        if (tested && deck !== s.cullDeck) { tested = false; onScreen = true; }
        s.cullKnown = true; s.cullX = pose.p.x; s.cullY = pose.p.y; s.cullDeck = deck;
        if (visible && !tested && !(reach >= seen && visible(pose.p.x, pose.p.y, deck, seen))) {
          if (!visible(pose.p.x, pose.p.y, deck, reach)) return;
          onScreen = reach >= seen ? false : visible(pose.p.x, pose.p.y, deck, seen);
        }
        // Its own level, by the screen's scale where it stands (a tenth of hysteresis going up).
        const pixels = screenScale ? screenScale(pose.p.x, pose.p.y, deck) : Infinity;
        const was = s.lod;
        let own = -1;
        for (let level = 2; level >= 0; level--) {
          const edge = level === 2 ? occupantZoom : level === 1 ? FAR_BODY_ZOOM : 2 / CAR_LENGTH;
          if (pixels >= (level > was ? edge * (1 + VEHICLE_HYSTERESIS) : edge)) { own = level; break; }
        }
        if (own < 0) return;
        // Whole: at most `VEHICLE_NEAR_CAP`, the biggest on the screen (last frame's floor).
        if (own === 2) {
          own = wholeOrNot(pixels);
          if (cellRecord) { cellRecord.pixels.push(pixels); cellRecord.whole.push(own === 2); }
        }
        const level = Math.min(vehicleBand, own);
        if (twoWheeled && level === 2) bikesWholeNow = true;
        // A car's tyres cast only with its whole body (level 2): at level 1 its shadow is the soft disc, the tyres' dots under it were the player's to drop (2026-10-17).
        if (!twoWheeled && level >= 2) { carsWheeled = true; if (cellRecord) cellRecord.wheeled = true; }
        const parked = free && vehicle.seats === 0 && vehicle.v === 0;
        drawPixels = pixels * levelRatio;
        // Stopped in the traffic a whole tick (a light, a queue), no indicator flashing, nobody drawn in it: as still as a parked car.
        const stopped = !free && vehicle.v === 0 && vehicle.prev.v === 0 && vehicle.indicator === 0 && (level < 2 || vehicle.seats === 0);
        // Standing where it stood, drawn as it was: its instances kept where they were written, nothing written or sent.
        let still = (parked || stopped) && !twoWheeled && vehicle.doors.length === 0 && !vehicle.kerbStop;
        const levels = still ? levelsKey(plan, drawPixels) : 0;
        if (still) {
          if (s.keptAt >= 0 && s.keptX === pose.p.x && s.keptY === pose.p.y && s.keptAngle === pose.angle && s.keptDeck === deck
            && s.keptBand === level && s.keptLevels === levels && s.keptVersion === levelsVersion && s.keptPaint === s.paint
            && s.keptShadows === softShadows && s.keptCastOnly === !onScreen && s.keptParked === parked) {
            seeKept(s);
            s.seen = suspensionFrame;
            s.lod = own;
            if (cellRecord) { cellRecord.kept.push(s); standsIn(cellRecord, plan, own, pixels, onScreen, pose.p.x, pose.p.y, seen); }
            // A car stopped in the traffic still runs: its smoke leaves it every frame.
            if (options.exhaust && level >= 1 && !parked) options.exhaust(pose.p.x, pose.p.y, deck, pose.angle, plan.length, vehicle.v, free);
            return;
          }
          // Its kept instances already drawn this frame by another view of the id: this one drawn with the frame's.
          if (s.keptSeen === suspensionFrame) still = false;
          // Moved, levelled, repainted: what was kept of it goes before it is written again.
          else if (s.keptAt >= 0) dropKept(s);
        }
        // A parked car's engine is off; a bicycle has none. Far off (the proxy), no smoke drawn.
        if (options.exhaust && level >= 1 && plan.shape !== 'bicycle' && !parked) {
          // Off the road (a lot, a drive) the wheels raise dust.
          options.exhaust(pose.p.x, pose.p.y, deck, pose.angle, plan.length, vehicle.v, free);
        }
        // A two-wheeler leans into its bend and, stopped, tilts onto the rider's foot on the road (`TwoWheelerFit.stopTilt`).
        const fit = twoWheeled ? s.bike?.model.fit : undefined;
        // The road under each axle and each side
        const front = plan.axleAlong[0] ?? plan.length * 0.35;
        const rear = plan.axleAlong[plan.axleAlong.length - 1] ?? -plan.length * 0.35;
        const seg = free ? undefined : vehicle.inSegment;
        currentSegment = seg;
        // A car off the road stands level on its lot (lots are laid near flat).
        const slope = !free && (level >= 2 || twoWheeled || !s.rideSet || (level === 1 && ((suspensionFrame + vehicle.id) & 1) === 0));
        const want = WANT;
        if (free || (level === 0 && !twoWheeled)) { want.deck = deck; want.pitch = 0; want.roll = 0; }
        else if (slope) roadFrameInto(elevationOnCurrent, pose.p.x, pose.p.y, pose.angle, front, rear, twoWheeled ? 0 : plan.axleSide, deck, want);
        else { want.deck = deck; want.pitch = s.pitch; want.roll = s.roll; }
        // Suspension: pitch and roll ease towards the road over a few hundredths of a second, so a change of grade is ridden
        if (!s.rideSet || Math.abs(s.pitch - want.pitch) > 0.2) {
          s.rideSet = true;
          s.pitch = want.pitch;
          s.roll = want.roll;
        } else {
          const k = 1 - Math.exp(-suspensionDt / SUSPENSION_TAU);
          s.pitch += (want.pitch - s.pitch) * k;
          s.roll += (want.roll - s.roll) * k;
        }
        s.deck = want.deck;
        s.seen = suspensionFrame;
        s.lod = own;
        frameAt(pose.p.x, pose.p.y, pose.angle, s.deck,
          twoWheeled ? leanOf(vehicle, s) + (fit ? fit.stopTilt * (1 - riderMoving(vehicle)) : 0) : 0,
          s.pitch, s.roll);
        occupantBand = twoWheeled ? vehicleBand : level;
        frameClock = vehicle.age;

        // Brakes and indicators, straight off the simulation.
        const decel = (vehicle.prev.v - vehicle.v) / DT;
        // A car standing in its bay with nobody in it has its lamps off.
        lamp.head = parked ? T_HEADLAMP_OFF : T_HEADLAMP;
        lamp.tail = parked ? T_TAILLAMP_OFF : decel >= BRAKE_DECEL ? T_BRAKELAMP : T_TAILLAMP;
        // `lateral` is the unfinished part of a lane change, signed towards the lane being left
        if (level >= 1 || twoWheeled) {
          const side = free ? 0 : vehicle.indicator;
          lamp.indicate = side !== 0 && blinkOn(vehicle.age, vehicle.id) ? side : 0;
          const axles = plan.axleAlong;
          lamp.steer = free ? 0 : steerFrom(vehicle.curvature, (axles[0] ?? 0) - (axles[axles.length - 1] ?? 0));
          const driven = vehicle.odometer;
          lamp.spin = -driven / Math.max(plan.wheelRadius, 1e-3);
          // A bicycle's cranks turn a little over half a turn per turn of the wheel: about 80 rpm at a city cyclist's 18 km/h.
          lamp.crank = (driven / (2 * Math.PI * Math.max(plan.wheelRadius, 1e-3))) * CRANK_RATIO * 2 * Math.PI;
        } else { lamp.indicate = 0; lamp.steer = 0; }
        // Standing still: written into the kept instances, to stay there while it stands as it is.
        if (still) { recording = s; s.keptAt = keptList.push(s) - 1; }
        castOnly = !onScreen;
        switch (plan.shape) {
          case 'motorcycle':
          case 'bicycle':
            drawTwoWheeler(vehicle, s, Math.max(1, vehicleBand));
            break;
          case 'car':
          case 'bus':
          case 'truck':
            drawCar(vehicle, s, level);
            break;
        }
        // Below the whole level, its shadow is a soft disc (the body casts none); a two-wheeler's too while none is drawn whole
        if ((twoWheeled ? !bikesCast : level < 2) && softShadows) placeBlob(pose.p.x, pose.p.y, s.deck, pose.angle, plan.length * 0.55, plan.width * 0.62);
        castOnly = false;
        // A cell is kept whole only while every car of it drawn stands as kept.
        if (cellRecord) {
          if (still) { cellRecord.kept.push(s); standsIn(cellRecord, plan, own, pixels, onScreen, pose.p.x, pose.p.y, seen); } else cellRecord.still = false;
        }
        if (still) {
          recording = null;
          seeKept(s);
          s.keptX = pose.p.x; s.keptY = pose.p.y; s.keptAngle = pose.angle; s.keptDeck = deck;
          s.keptBand = level; s.keptLevels = levels; s.keptVersion = levelsVersion; s.keptPaint = s.paint; s.keptShadows = softShadows; s.keptCastOnly = !onScreen; s.keptParked = parked;
        }
          };
      // DO NOT walk the parked cars of a cell that stands as drawn in a view that stands: its version (`SimClient.parkedCellsIn`) and the view's, the diary's and the levels' unchanged.
      const box = options.vehicleBox;
      const probe = screenScale && box ? screenScale(box.x0, box.y0, 0) : 0;
      const eye = options.eye;
      const view = viewKey;
      const viewStands = !!box && view.x0 === box.x0 && view.y0 === box.y0 && view.x1 === box.x1 && view.y1 === box.y1 && view.zoom === zoom
        && view.probe === probe && view.ex === (eye?.x ?? 0) && view.ey === (eye?.y ?? 0) && view.ez === (eye?.z ?? 0) && view.ratio === pixelRatio
        && view.shadows === softShadows && view.occupant === occupantZoom && view.detailed === detailed && view.serial === offRoadSerial && view.levels === levelsVersion;
      if (box) Object.assign(view, { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, zoom, probe, ex: eye?.x ?? 0, ey: eye?.y ?? 0, ez: eye?.z ?? 0, ratio: pixelRatio,
        shadows: softShadows, occupant: occupantZoom, detailed, serial: offRoadSerial, levels: levelsVersion });
      /** The cap's answers for a kept cell, asked again in this frame's order: the same answers, or the cell is walked (the counts put back). */
      const replays = (was: CellRecord): boolean => {
        const count = nearCount, wholeBefore = whole;
        for (let i = 0; i < was.pixels.length; i++) {
        if ((wholeOrNot(was.pixels[i]!) === 2) === was.whole[i]) continue;
        nearCount = count; whole = wholeBefore;
        return false;
        }
        return true;
      };
      if (box) {
        for (const vehicle of world.vehiclesIn(box, inView, 'traffic')) drawVehicle(vehicle);
        cellsSeen.clear();
        for (const cell of world.parkedCellsIn(box, cellsIn)) {
          cellsSeen.add(cell.key);
          const was = cellsDrawn.get(cell.key);
          if (viewStands && was && was.version === cell.version && was.still && replays(was)) {
            for (const s of was.kept) { seeKept(s); s.seen = suspensionFrame; }
            if (was.wheeled) carsWheeled = true;
            continue;
          }
          // DO NOT walk the parked cars of a cell standing as drawn while the view moves: the cell wholly on screen, and its cars' scales there (at the corners of where they stand: `screenScale` goes as one over the depth) within those every car keeps its levels over.
          if (was && options.vehicleInside && screenScale && was.still && was.onScreen && was.kept.length === was.count && was.count === cell.items.length
            && was.version === cell.version && was.serial === offRoadSerial && was.band === vehicleBand && was.ratio === levelRatio && was.nearCap === nearCap && was.shadows === softShadows
            && was.occupant === occupantZoom && was.levels === levelsVersion && was.bounded && was.rangeLo < was.rangeHi) {
            const across = Math.hypot((was.x1 - was.x0) / 2, (was.y1 - was.y0) / 2);
            const upright = (was.hi + 0.3 * was.radius - was.lo) / 2;
            const radius = Math.hypot(across, upright) + was.radius;
            if (options.vehicleInside((was.x0 + was.x1) / 2, (was.y0 + was.y1) / 2, was.lo + upright - 0.3 * radius, radius)) {
              const field = depthField(screenScale, box);
              // One over the scale at the box's nearest and farthest corners (each axis at the end its slope picks).
              let near = field[0]!, far = field[0]!;
              for (const [axis, a, b] of [[1, was.x0, was.x1], [2, was.y0, was.y1], [3, was.lo, was.hi]] as const) {
                const g = field[axis]!;
                near += Math.min(g * a, g * b);
                far += Math.max(g * a, g * b);
              }
              if (field.valid && near > 0 && 1 / far * (1 - FIELD_SLACK) > was.rangeLo && 1 / near * (1 + FIELD_SLACK) < was.rangeHi) {
                for (const s of was.kept) { seeKept(s); s.seen = suspensionFrame; }
                if (was.wheeled) carsWheeled = true;
                continue;
              }
            }
          }
          // DO NOT walk the cars of a cell off the view: one sphere over the cell and its cars' decks (as last tested, nothing of it changed since) tested first.
          if (was && options.vehicleVisible && was.bounded && was.version === cell.version && was.serial === offRoadSerial) {
            const middle = (was.lo + was.hi) / 2 + 0.3 * VEHICLE_REACH;
            const radius = Math.hypot(CELL_HALF_DIAGONAL, (was.hi - was.lo) / 2 + 0.3 * VEHICLE_REACH) + VEHICLE_REACH;
            if (!options.vehicleVisible((cell.cx + 0.5) * FLEET_CELL, (cell.cy + 0.5) * FLEET_CELL, middle - 0.3 * radius, radius)) continue;
          }
          cellRecord = was ?? { version: 0, lo: 0, hi: 0, bounded: false, serial: -1, still: true, kept: [], pixels: [], whole: [], wheeled: false,
            count: 0, onScreen: true, rangeLo: 0, rangeHi: 0, x0: 0, y0: 0, x1: 0, y1: 0, radius: 0, band: 0, ratio: 0, nearCap: 0, shadows: false, occupant: 0, levels: 0 };
          cellRecord.version = cell.version; cellRecord.still = true; cellRecord.kept.length = 0;
          cellRecord.pixels.length = 0; cellRecord.whole.length = 0; cellRecord.wheeled = false;
          Object.assign(cellRecord, { count: cell.items.length, onScreen: true, rangeLo: -Infinity, rangeHi: Infinity, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, radius: 0,
            band: vehicleBand, ratio: levelRatio, nearCap, shadows: softShadows, occupant: occupantZoom, levels: levelsVersion });
          cellsDrawn.set(cell.key, cellRecord);
          let lo = Infinity, hi = -Infinity, bounded = true;
          for (const vehicle of cell.items) {
            drawVehicle(vehicle);
            const d = draws.get(vehicle.id);
            if (!d || !d.cullKnown || d.view !== vehicle) { bounded = false; continue; }
            if (d.cullDeck < lo) lo = d.cullDeck;
            if (d.cullDeck > hi) hi = d.cullDeck;
          }
          cellRecord.lo = lo; cellRecord.hi = hi; cellRecord.bounded = bounded && lo <= hi; cellRecord.serial = offRoadSerial;
          cellRecord = null;
        }
        // A cell gone from the view (or emptied): drawn again when it comes back.
        if (cellsDrawn.size > cellsSeen.size) for (const key of cellsDrawn.keys()) if (!cellsSeen.has(key)) cellsDrawn.delete(key);
      } else for (const list of [world.traffic, world.parked]) for (const vehicle of list) drawVehicle(vehicle);
      // The parked cars kept and not drawn this frame (gone, out of view, under two pixels, moving off): let go before the frame is drawn.
      // DO NOT walk every kept car to find none missing: only when fewer were seen than are kept.
      if (keptSeenNow < keptList.length) for (let i = keptList.length - 1; i >= 0; i--) { const s = keptList[i]!; if (s.keptSeen !== suspensionFrame) dropKept(s); }
      // The two-wheelers cast only while one is drawn whole; the shared tyres also while a car is drawn with its wheels.
      castersChanged = thinWheels.mesh.castShadow !== bikesCast;
      for (const t of twoWheelerParts.values()) {
        for (const part of t.body.parts) part.mesh.castShadow = bikesCast;
        for (const part of t.trim.parts) part.mesh.castShadow = bikesCast;
      }
      thinWheels.mesh.castShadow = bikesCast;
      for (const part of wheelLevels.parts) part.mesh.castShadow = bikesCast || carsWheeled;
      bikesWhole = bikesWholeNow;
      // Next frame's floor for the whole level: the cap's smallest of this frame (the cap-th largest, sorted ascending).
      if (nearCount > nearCap) nearFloor = nearCandidates.subarray(0, nearCount).sort()[nearCount - nearCap]!;
      else nearFloor = 0;

      // Pedestrians start at band 1: zoomed out past it a whole person is smaller than a car's wing mirror
      if (band >= 1) {
        let pedCount = 0;
        // The view's ground (`vehicleBox`, grown by `VEHICLE_REACH`, more than a walker's 8 m sphere): a walker off it is never asked a height.
        const box = PED_IN_BOX ? options.vehicleBox : undefined;
        for (const ped of world.pedViews) {
          if (pedCount >= MAX_PEDS) break;
          // DO NOT ask a walker off the view's ground whether a ragdoll hides them, nor their pose: it lies between where they were and are (`pedPoseInto`), tested with those two.
          if (box) {
            const ax = ped.prev.x, ay = ped.prev.y, bx = ped.x, by = ped.y;
            if ((ax < bx ? bx : ax) < box.x0 || (ax < bx ? ax : bx) > box.x1 || (ay < by ? by : ay) < box.y0 || (ay < by ? ay : by) > box.y1) continue;
          }
          if (options.hiddenPed?.(ped.id)) continue;
          pedPoseInto(ped, alpha, POSE);
          const pose = POSE;
          if (box && (pose.p.x < box.x0 || pose.p.x > box.x1 || pose.p.y < box.y0 || pose.p.y > box.y1)) continue;
          const open = ped.ground === 'open';
          const segment = ped.segment;
          currentSegment = segment;
          const land = open && groundAt ? groundAt : elevationOnCurrent;
          // DO NOT ask them of every walker of the simulation before the test.
          const below = open ? (roughGroundAt ?? land)(pose.p.x, pose.p.y) : elevationAt(pose.p.x, pose.p.y, segment);
          if (options.pedestrianVisible && !options.pedestrianVisible(pose.p.x, pose.p.y, below)) continue;
          const rise = open ? m(0.04) : footwayRiseAt(net, pose.p.x, pose.p.y) * walkingRise(net, pose.p.x, pose.p.y, ped.ground !== 'crossing',
            segment === undefined ? 'ground' : net.doc.segment(segment)?.structure ?? 'ground');
          const deck = (open && roughGroundAt ? land(pose.p.x, pose.p.y) : below) + rise;
          // (No vehicle frame worked out for a walker: both bodies are drawn from the pose and the deck alone.)
          if (procedural && ped.id !== PLAYER_ID) {
            // What they are doing shows before the fright on their face (a photo held up, a crouch, a fall).
            const doing = ped.gesture?.kind;
            // Shot and still going: the pain on their face over the fright.
            const shown = doing === 'photo' || doing === 'crouch' || doing === 'fall' || doing === 'flinch' || doing === 'look' || doing === 'mourn' || doing === 'crawl' ? doing : ped.bleeding ? 'hurt' : ped.panic ? 'panic' : doing;
            if (ped.bleeding || ped.lost?.length) procBleed?.(ped.id, pose.p.x, pose.p.y, deck);
            // The gait at the body's real speed: a step aside is steps, not a glide.
            const gait = gaitSpeed(ped);
            procDraw(ped.id, pose.p.x, pose.p.y, pose.angle, deck, gait, ped.walking || gait > m(0.15), gaitDt, shown,
              ped.lost ?? (ped.maimed ? [ped.maimed] : undefined), ped.gesture ? { t: ped.gesture.t, hold: ped.gesture.hold ?? 0 } : undefined, ped.wound, ped.ageClass);
          }
          else {
            // The rise is the same on both sides of the difference, so the gradient is the road's own under the walker.
            const ground = groundGradient(land,
              pose.p.x, pose.p.y, deck - rise);
            pedestrians.draw(ped, pose.p.x, pose.p.y, pose.angle, deck, alpha, ground);
          }
          pedCount++;
        }
      }

      if (procedural) {
        // The walkers of the simulation, gathered once a tick (DO NOT add every walker of the region to a set each frame: they change only when a tick is read).
        if (procLiveTick !== world.tick || procLiveViews !== world.pedViews.length) {
          procLiveTick = world.tick; procLiveViews = world.pedViews.length;
          procLive.clear();
          for (const ped of world.pedViews) procLive.add(ped.id);
        }
        procFinish(options.eye, procLive);
      }
      // The ragdolls draw the procedural people as themselves (`procRagdoll`), the rest as cooked bodies.
      procHeldNow.clear();
      options.ragdolls?.(procedural ? procRagdoll : riggedRagdoll);
      if (procedural) {
        // Let go of those the ragdolls no longer hold (up again).
        for (const id of procHeld) if (!procHeldNow.has(id)) { const p = procPeople.get(id)?.person; if (p) procedural.ragdoll.hold(p, null); }
        procHeld.clear();
        for (const id of procHeldNow) procHeld.add(id);
        procedural.update(options.eye, gaitClock < 0 ? undefined : gaitClock, options.shadows !== false, options.tier?.hairStrandPeople);
      }
      pedestrians.finish();

      // Send only what changed: this frame's instances, and the kept ones moved or written since the GPU last took them.
      // DO NOT call the shadow map's casters moving for what stands still: only a casting part with instances written, moved or gone this frame (a parked car kept is none).
      casting = pedestrians.casting || (procedural ? procedural.casting : false);
      let drawn = 0;
      for (let i = 0; i < live.length; i++) {
        const part = live[i]!, mesh = part.mesh, n = part.n;
        mesh.count = n;
        // An empty instanced mesh still costs a program bind, its uniforms and a state change in every pass
        mesh.visible = n > 0;
        if ((mesh.castShadow && n !== part.shown) || (n > 0 && mesh.castShadow !== part.castLast)) casting = true;
        part.shown = n;
        part.castLast = mesh.castShadow;
        if (n === 0) { part.listed = false; part.lo = 0; part.hi = 0; continue; }
        live[drawn++] = part;
        if (n > part.kept) touch(part, part.kept, n);
        if (mesh.castShadow && part.hi > part.lo) casting = true;
        const hi = Math.min(part.hi, n);
        if (hi <= part.lo) continue;
        send(mesh.instanceMatrix, part.lo, hi, 16);
        if (part.tinted) send(mesh.instanceColor!, part.lo, hi, 3);
        if (part === lamps) send(lampGlow, part.lo, hi, 1);
      }
      live.length = drawn;
    },
    dispose() {
      pedestrians.dispose();
      blobs.mesh.dispose();
      blobs.mesh.geometry.dispose();
      (blobs.mesh.material as Material).dispose();
      for (const part of allParts) part.mesh.dispose();
      for (const geometry of [
        unitBox,
        torsoGeometry,
        wheelGeometry,
        hubGeometry,
        thinTyreGeometry,
        spokedGeometry,
        headGeometry,
        helmetGeometry,
      ]) {
        geometry.dispose();
      }
      for (const geometry of modelGeometries) geometry.dispose();
      for (const material of [paint, trim, glassMaterial, rubber, lampMaterial, cloth, cabinMaterial]) {
        material.dispose();
      }
    },
  };
}

/** Narrows a unit box towards its top, in place. */
function taper(geometry: BufferGeometry, topX: number, topZ: number): void {
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) > 0) {
      position.setX(i, position.getX(i) * topX);
      position.setZ(i, position.getZ(i) * topZ);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}
