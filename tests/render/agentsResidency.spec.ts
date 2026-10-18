import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentMeshes } from '@render/agents';
import { FleetGrid, type FleetCell, type GroundBox } from '@sim/host/fleetGrid';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';
import { TILE } from '@world/tiles';

/** What the page keeps of the vehicles while the camera walks a city: bounded by the view and the region, the same after 10 tiles as after 20 (the map's size is not read). */

function parkedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById(id % 3 === 0 ? 'suv' : 'sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot: null },
    frames: { bx: x, by: y, bangle: 0.3, x, y, angle: 0.3, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

/** A car stopped at a light a whole tick, on its lane. */
function stoppedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById('sedan'), color: '#2f5f92', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: null, frames: { bx: x, by: y, bangle: 0, x, y, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

function worldWith(parked: readonly VehicleView[], traffic: readonly VehicleView[]): SimClient {
  const grid = new FleetGrid<VehicleView>();
  for (const car of parked) grid.place(car);
  const vehiclesIn = (_box: GroundBox, out: VehicleView[], which = 'all'): VehicleView[] => { out.length = 0; if (which === 'traffic') out.push(...traffic); return out; };
  const parkedCellsIn = (box: GroundBox, out: FleetCell<VehicleView>[]): FleetCell<VehicleView>[] => { out.length = 0; return grid.cellsNear(box.x0, box.y0, box.x1, box.y1, out); };
  const vehicles = new Map<number, VehicleView>(traffic.map((v) => [v.id, v] as const));
  return { time: 0, traffic, vehicles, parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: [], onVehicleGone: null, vehiclesIn, parkedCellsIn } as unknown as SimClient;
}



describe('the vehicles kept on the page', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('are as many after 10 tiles walked as after 20: the region and the view, not the path', () => {
    const net = { doc: { changes: new ChangeJournal() } } as unknown as Network;
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    let nextId = 1;
    const tileCars = new Map<number, VehicleView[]>();
    // Each tile's 40 parked cars, made when the region reaches it and let go when it leaves, as the simulation's region does.
    const carsOf = (i: number, j: number): VehicleView[] => {
      const k = i * 1000 + j;
      let list = tileCars.get(k);
      if (!list) { list = []; for (let c = 0; c < 40; c++) list.push(parkedCar(nextId++, (i + (c % 8) / 8 + 0.03) * TILE, (j + Math.floor(c / 8) / 5 + 0.05) * TILE)); tileCars.set(k, list); }
      return list;
    };
    let pos = 0;
    const walk = (tiles: number): ReturnType<typeof createAgentMeshes>['held'] => {
      while (pos < tiles * TILE) {
        pos += m(16);
        const ci = Math.floor(pos / TILE);
        const parked: VehicleView[] = [];
        for (let i = ci - 1; i <= ci + 1; i++) for (let j = -1; j <= 1; j++) parked.push(...carsOf(i, j));
        for (const k of [...tileCars.keys()]) if (Math.abs(Math.round(k / 1000) - ci) > 1) tileCars.delete(k);
        // The traffic about the camera, other cars on each tile.
        const traffic = Array.from({ length: 80 }, (_, k) => ({ ...stoppedCar(1e6 + ci * 100 + k, pos + (k % 20) * m(15) - m(150), (k / 20 - 2) * m(40)), v: m(8), prev: { v: m(8) } }));
        agents.sync(worldWith(parked, traffic), net, 0.5, true, 6,
          { vehicleVisible: () => true, vehicleBox: { x0: pos - m(400), y0: -m(400), x1: pos + m(400), y1: m(400) }, screenScale: () => 6 });
      }
      return agents.held;
    };
    walk(2);
    const ten = walk(10);
    const twenty = walk(20);
    // The region holds 9 tiles of 40 parked cars and 80 moving; the vehicles' records are those seen since the last sweep (`sync`, every 600 frames), whatever the path.
    for (const held of [ten, twenty]) {
      expect(held.kept).toBeLessThanOrEqual(9 * 40);
      expect(held.cells).toBeLessThanOrEqual(9 * 16 * 16);
    }
    expect(twenty.vehicles).toBeLessThanOrEqual(ten.vehicles * 1.25);
    expect(twenty.kept).toBe(ten.kept);
    expect(twenty.cells).toBe(ten.cells);
    agents.dispose();
  }, 10000);
});
