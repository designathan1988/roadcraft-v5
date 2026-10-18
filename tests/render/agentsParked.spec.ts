import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three';

import { createAgentMeshes } from '@render/agents';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import type { Network } from '@world/network';
import { ChangeJournal, journalWork } from '@world/changes';
import { FLEET_CEILING } from '@sim/params';
import { m } from '@world/units';

/** Parked cars as the renderer draws them: written once into instances kept where they are, never written or sent again while they stand (`Part.kept`). */

/** A car standing in its bay with nobody in it: what `sync` takes as parked. */
function parkedCar(id: number, x: number, y: number, lot: number | null = 1): VehicleView {
  // Nobody aboard: its engine off and its instances kept from frame to frame (`sync` `still`).
  return {
    id, archetype: archetypeById('sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot },
    frames: { bx: x, by: y, bangle: 0.3, x, y, angle: 0.3, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

/** A car driving along x on its lane, nobody drawn in it (no seat taken). */
function movingCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById('sedan'), color: '#2f5f92', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: m(5),
    prev: { v: m(5) }, free: null, frames: { bx: x, by: y, bangle: 0, x, y, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

/** The simulation's view `sync` reads (`SimClient`): the traffic, the parked cars, nobody walking. */
function worldWith(parked: readonly VehicleView[], traffic: readonly VehicleView[] = []): SimClient {
  const vehicles = new Map<number, VehicleView>(traffic.map((v) => [v.id, v] as const));
  return { time: 0, traffic, vehicles, parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: [], onVehicleGone: null } as unknown as SimClient;
}

/** The network `sync` reads: only its document's diary of changes. */
const netWith = (changes = new ChangeJournal()): Network => ({ doc: { changes } }) as unknown as Network;

const meshesOf = (agents: ReturnType<typeof createAgentMeshes>, test: RegExp): InstancedMesh[] =>
  agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && test.test(o.name));
const drawn = (meshes: readonly InstancedMesh[]): number => meshes.reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);

/** The GPU takes what was sent, as three does (`WebGLAttributes.updateBuffer`): the ranges cleared, the upload told. */
function uploaded(meshes: readonly InstancedMesh[]): void {
  for (const mesh of meshes) {
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.onUploadCallback();
  }
}

/** Each drawn body's place along x (its instance's translation), in order. */
const centres = (agents: ReturnType<typeof createAgentMeshes>): number[] => meshesOf(agents, /^car-.*-shell$/)
  .flatMap((mesh) => (mesh.visible ? Array.from({ length: mesh.count }, (_, i) => mesh.instanceMatrix.array[i * 16 + 12]!) : []))
  .sort((a, b) => a - b);

describe('parked cars drawn from instances kept where they were written', () => {
  // The page the meshes are made in: the cooked bodies only (`?bodies=cooked`), no procedural crowd.
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('keep their steering wheel in the kept instances', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const world = worldWith([parkedCar(1, 0, 0), parkedCar(2, m(10), 0)]);
    const wheels = meshesOf(agents, /^car-.*-wheel$/);
    expect(wheels.length).toBeGreaterThan(0);
    agents.sync(world, netWith(), 0, true);
    const first = drawn(wheels);
    expect(first).toBe(2);
    // The second frame draws what the first wrote, where it wrote it.
    agents.sync(world, netWith(), 0, true);
    expect(drawn(wheels)).toBe(first);
    agents.dispose();
  });

  it('stand on the ground again after the ground under them changed', () => {
    let lot = 0;
    const changes = new ChangeJournal();
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => lot);
    const world = worldWith([parkedCar(1, m(5), m(5))]);
    const net = netWith(changes);
    const bodies = meshesOf(agents, /^car-.*-shell$/);
    const height = (): number => {
      const mesh = bodies.find((b) => b.visible && b.count > 0);
      if (!mesh) throw new Error('no body drawn');
      return mesh.instanceMatrix.array[13]!;
    };
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(0, 6);
    // The lot raised by 2 m, and the diary told where (the ground cut and filled).
    lot = m(2);
    changes.record('ground', [[0, 0, m(10), m(10)]]);
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    // A change elsewhere does not move it (it is not asked again).
    lot = m(7);
    changes.record('ground', [[m(100), m(100), m(110), m(110)]]);
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    agents.dispose();
  });

  it('hold instance buffers sized to what is drawn, not to the fleet ceiling', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const all = meshesOf(agents, /^(car-|vehicle-(wheels|hubs|lamps)|bicycle-|bike-|rider-)/);
    expect(all.length).toBeGreaterThan(100);
    // Before anything is drawn: every part's buffers are a few instances, not the ceiling's, and none is shown.
    for (const mesh of all) expect(mesh.instanceMatrix.count).toBeLessThanOrEqual(16);
    expect(drawn(all)).toBe(0);
    const cars: VehicleView[] = [];
    for (let i = 0; i < 40; i++) cars.push(parkedCar(i + 1, (i % 10) * m(8), Math.floor(i / 10) * m(8)));
    agents.sync(worldWith(cars), netWith(), 0, true);
    const wheels = meshesOf(agents, /^vehicle-(wheels|hubs|lamps)|bicycle-wheels$/)[0]!;
    expect(wheels.count).toBe(160);
    // Doubled to hold them, no further.
    expect(wheels.instanceMatrix.count).toBeGreaterThanOrEqual(160);
    expect(wheels.instanceMatrix.count).toBeLessThan(320);
    expect(wheels.instanceColor!.count).toBe(wheels.instanceMatrix.count);
    agents.dispose();
  });

  it('are all drawn past the fleet ceiling', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const count = FLEET_CEILING + 300;
    const cars: VehicleView[] = [];
    for (let i = 0; i < count; i++) cars.push(parkedCar(i + 1, (i % 60) * m(8), Math.floor(i / 60) * m(8)));
    const world = worldWith(cars);
    const bodies = meshesOf(agents, /^car-.*-(shell|shell-lite|far)$/);
    // The cars' wheels alone: hubs and lamps grow with them too, past the ceiling (`growPart`).
    const wheels = meshesOf(agents, /^vehicle-wheels$/);
    agents.sync(world, netWith(), 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    // And kept in the next frame.
    agents.sync(world, netWith(), 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    agents.dispose();
  });

  it('are neither written nor sent again in a frame where nothing of them changed', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const world = worldWith([parkedCar(1, 0, 0), parkedCar(2, m(10), 0), parkedCar(3, m(20), m(10))]);
    const net = netWith();
    agents.sync(world, net, 0, true);
    const shown = meshesOf(agents, /./).filter((mesh) => mesh.visible);
    expect(shown.length).toBeGreaterThan(5);
    uploaded(shown);
    const versions = shown.map((mesh) => mesh.instanceMatrix.version);
    const matrices = (mesh: InstancedMesh): number[] => Array.from((mesh.instanceMatrix.array as Float32Array).subarray(0, mesh.count * 16));
    const before = shown.map(matrices);
    agents.sync(world, net, 0, true);
    shown.forEach((mesh, i) => {
      // Nothing to send: the buffer not marked, and the same numbers in it.
      expect(mesh.visible).toBe(true);
      expect(mesh.instanceMatrix.version, mesh.name).toBe(versions[i]);
      expect(matrices(mesh)).toEqual(before[i]);
    });
    agents.dispose();
  });

  it('do not move the shadow map while they stand: casting only in a frame where one came, moved or went', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const cars = [parkedCar(1, 0, 0), parkedCar(2, m(10), 0)];
    const net = netWith();
    agents.sync(worldWith(cars), net, 0, true);
    expect(agents.casting).toBe(true);
    uploaded(meshesOf(agents, /./));
    agents.sync(worldWith(cars), net, 0, true);
    expect(agents.casting).toBe(false);
    // One driven off: the map changes.
    agents.sync(worldWith([cars[0]!]), net, 0, true);
    expect(agents.casting).toBe(true);
    uploaded(meshesOf(agents, /./));
    agents.sync(worldWith([cars[0]!]), net, 0, true);
    expect(agents.casting).toBe(false);
    agents.dispose();
  });

  it('ask the ground again, not the diary, of a car not asked the frame before', () => {
    const changes = new ChangeJournal();
    let asked = 0;
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => { asked++; return 0; });
    const car = parkedCar(1, m(5), m(5));
    const net = netWith(changes);
    let seen = true;
    const options = { vehicleVisible: () => seen };
    agents.sync(worldWith([car]), net, 0, true, undefined, options);
    // Off the view a while, the diary filling meanwhile far from it.
    seen = false;
    for (let i = 0; i < 200; i++) {
      changes.record('ground', Array.from({ length: 20 }, (_, k) => [m(500 + k), m(500), m(501 + k), m(501)] as [number, number, number, number]));
      agents.sync(worldWith([car]), net, 0, true, undefined, options);
    }
    seen = true;
    const before = journalWork.entries;
    asked = 0;
    agents.sync(worldWith([car]), net, 0, true, undefined, options);
    // Its ground asked once; not the 200 entries since it was last asked.
    expect(asked).toBe(1);
    expect(journalWork.entries - before).toBeLessThan(10);
    agents.dispose();
  });

  it('grow a part without disposing its mesh (three walks every geometry it knows to release one)', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const wheels = meshesOf(agents, /^vehicle-wheels$/)[0]!;
    let disposed = 0;
    wheels.addEventListener('dispose', () => { disposed++; });
    const cars: VehicleView[] = [];
    for (let i = 0; i < 40; i++) cars.push(parkedCar(i + 1, (i % 10) * m(8), Math.floor(i / 10) * m(8)));
    agents.sync(worldWith(cars), netWith(), 0, true);
    expect(wheels.instanceMatrix.count).toBeGreaterThanOrEqual(160);
    expect(disposed).toBe(0);
    agents.dispose();
  });

  it('let one go with its instances: the last kept ones take their places, and only those places are sent', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const cars = [parkedCar(1, 0, 0), parkedCar(2, m(10), 0), parkedCar(3, m(20), 0)];
    const net = netWith();
    agents.sync(worldWith(cars), net, 0, true);
    expect(centres(agents)).toEqual([0, m(10), m(20)]);
    const wheels = meshesOf(agents, /^vehicle-wheels$/)[0]!;
    expect(wheels.count).toBe(12);
    uploaded(meshesOf(agents, /./));
    // The middle car driven off: its four wheels' places taken by the last car's.
    agents.sync(worldWith([cars[0]!, cars[2]!]), net, 0, true);
    expect(centres(agents)).toEqual([0, m(20)]);
    expect(wheels.count).toBe(8);
    expect(wheels.instanceMatrix.updateRanges).toEqual([{ start: 4 * 16, count: 4 * 16 }]);
    // Gone from the view altogether: nothing of it left drawn.
    agents.sync(worldWith([]), net, 0, true);
    expect(centres(agents)).toEqual([]);
    expect(wheels.visible).toBe(false);
    agents.dispose();
  });

  it('keep a car stopped in the traffic as a parked one, its smoke still leaving it, until it moves off', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    // Stopped at a light a whole tick: no speed now nor in the tick before, no indicator.
    const car: VehicleView = { ...movingCar(9, m(30), m(20)), v: 0, prev: { v: 0 } };
    const net = netWith();
    let smoke = 0;
    const options = { exhaust: () => { smoke++; } };
    agents.sync(worldWith([], [car]), net, 0, true, undefined, options);
    const shown = meshesOf(agents, /./).filter((mesh) => mesh.visible);
    uploaded(shown);
    const versions = shown.map((mesh) => mesh.instanceMatrix.version);
    agents.sync(worldWith([], [car]), net, 0, true, undefined, options);
    shown.forEach((mesh, i) => expect(mesh.instanceMatrix.version, mesh.name).toBe(versions[i]));
    expect(centres(agents)).toEqual([m(30)]);
    expect(smoke).toBe(2);
    // Its indicator on: drawn each frame again (the lamp flashes).
    const signalling: VehicleView = { ...car, indicator: 1 };
    agents.sync(worldWith([], [signalling]), net, 0, true, undefined, options);
    // Moving off: written where it is now.
    const off: VehicleView = { ...car, v: m(2), frames: { ...car.frames, bx: m(30), x: m(31) } };
    agents.sync(worldWith([], [off]), net, 1, true, undefined, options);
    expect(centres(agents)).toEqual([m(31)]);
    agents.dispose();
  });

  it('draw a car on the move after the kept ones, its own instances sent each frame and nothing else', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const parked = [parkedCar(1, 0, 0), parkedCar(2, m(10), 0)];
    const car = movingCar(9, m(30), m(20));
    const net = netWith();
    agents.sync(worldWith(parked, [car]), net, 0, true);
    const wheels = meshesOf(agents, /^vehicle-wheels$/)[0]!;
    expect(wheels.count).toBe(12);
    expect(centres(agents)).toEqual([0, m(10), m(30)]);
    uploaded(meshesOf(agents, /./));
    // A tick later it has gone on 2 m.
    car.frames.bx = car.frames.x = m(32);
    agents.sync(worldWith(parked, [car]), net, 0, true);
    expect(centres(agents)).toEqual([0, m(10), m(32)]);
    // Its four wheels after the parked cars' eight, the only ones sent.
    expect(wheels.instanceMatrix.updateRanges).toEqual([{ start: 8 * 16, count: 4 * 16 }]);
    const moved = Array.from({ length: 4 }, (_, i) => wheels.instanceMatrix.array[(8 + i) * 16 + 12]!);
    for (const x of moved) expect(Math.abs(x - m(32))).toBeLessThan(m(3));
    agents.dispose();
  });
});
