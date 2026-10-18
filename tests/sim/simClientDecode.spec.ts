import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { H, P, PARKED_STRIDE, PED_STRIDE, PK, V, VEHICLE_STRIDE, headBase, pedBase, vehicleBase, type FromSim, type PedRich, type ParkedChanges, type SimStats } from '@sim/host/protocol';
import { RoadDoc } from '@world/doc';

/** THE PAGE READS THE WORKER'S FRAME (`SimClient.readTick`): each vehicle's view kept from tick to tick and written in place, those not in a tick let go */

type Inside = { receive(message: FromSim): void; readonly data: Float64Array };
const inside = (client: SimClient): Inside => client as unknown as Inside;

/** A vehicle's numbers in the slot: where it is, and off the road (1) or on a lane (0). */
interface Written { readonly id: number; readonly x: number; readonly y: number; readonly free: 0 | 1; readonly lot?: number }

/** A tick written into slot 0 (the slot `C.latest` names while nothing else is), then told. */
function tick(client: SimClient, vehicles: readonly Written[], parked: ParkedChanges | null = null): void {
  const data = inside(client).data;
  data[headBase(0) + H.vehicles] = vehicles.length;
  data[headBase(0) + H.peds] = 0;
  vehicles.forEach((v, k) => {
    const at = vehicleBase(0) + k * VEHICLE_STRIDE;
    data.fill(0, at, at + VEHICLE_STRIDE);
    data[at + V.id] = v.id;
    data[at + V.free] = v.free;
    data[at + V.bx] = v.x; data[at + V.by] = v.y; data[at + V.x] = v.x; data[at + V.y] = v.y;
    data[at + V.segment] = -1; data[at + V.inSegment] = -1; data[at + V.lot] = v.lot ?? -1;
  });
  const stats = { issues: [] } as unknown as SimStats;
  inside(client).receive({ type: 'tick', slot: 0, vehicles: [], peds: [], signals: [], layout: null, trains: [], parked, stats, wounds: [], casualties: [] });
}

describe("the page's reading of the fleet", () => {
  it('keeps each view and its pose off the road from tick to tick, written in place', () => {
    const client = new SimClient(new RoadDoc());
    tick(client, [{ id: 1, x: 5, y: 6, free: 1, lot: 3 }, { id: 2, x: 50, y: 0, free: 0 }]);
    expect(client.traffic.map((v) => v.id)).toEqual([1, 2]);
    const one = client.vehicles.get(1)!;
    const pose = one.free!;
    expect(pose).toMatchObject({ x: 5, y: 6, lot: 3 });
    expect(client.vehicles.get(2)!.free).toBeNull();
    // Moved on: the same view, the same pose object with the new numbers.
    tick(client, [{ id: 1, x: 7, y: 6, free: 1 }, { id: 2, x: 52, y: 0, free: 0 }]);
    expect(client.vehicles.get(1)).toBe(one);
    expect(one.free).toBe(pose);
    expect(pose).toMatchObject({ x: 7, y: 6, lot: null });
    // Back on a lane: no pose off the road.
    tick(client, [{ id: 1, x: 9, y: 6, free: 0 }, { id: 2, x: 54, y: 0, free: 0 }]);
    expect(one.free).toBeNull();
  });

  it('lets go the views not read in a tick, and only those', () => {
    const client = new SimClient(new RoadDoc());
    tick(client, [{ id: 1, x: 0, y: 0, free: 0 }, { id: 2, x: 10, y: 0, free: 0 }, { id: 3, x: 20, y: 0, free: 0 }]);
    const two = client.vehicles.get(2)!;
    const gone: number[] = [];
    client.onVehicleGone = (view) => gone.push(view.id);
    // Vehicle 1 gone, 4 come: 2 and 3 kept as they were; only 1 told gone.
    tick(client, [{ id: 2, x: 11, y: 0, free: 0 }, { id: 3, x: 21, y: 0, free: 0 }, { id: 4, x: 30, y: 0, free: 0 }]);
    expect([...client.vehicles.keys()].sort()).toEqual([2, 3, 4]);
    expect(client.vehicles.get(2)).toBe(two);
    expect(gone).toEqual([1]);
    expect(client.vehiclesIn({ x0: -5, y0: -5, x1: 5, y1: 5 }, [])).toEqual([]);
    // The same vehicles again: none let go.
    tick(client, [{ id: 2, x: 12, y: 0, free: 0 }, { id: 3, x: 22, y: 0, free: 0 }, { id: 4, x: 31, y: 0, free: 0 }]);
    expect(client.vehicles.size).toBe(3);
    expect(gone).toEqual([1]);
    // All gone.
    tick(client, []);
    expect(client.vehicles.size).toBe(0);
    expect(client.traffic).toEqual([]);
  });

  it('applies the parked cars told by id: kept views written in place, gone ones let go, a whole list letting go those it does not name', () => {
    const client = new SimClient(new RoadDoc());
    const told = (whole: boolean, cars: readonly { id: number; x: number; gone?: boolean }[]): ParkedChanges => {
      const out = new Float64Array(cars.length * PARKED_STRIDE);
      cars.forEach((c, k) => {
        const at = k * PARKED_STRIDE;
        out[at + PK.id] = c.id; out[at + PK.gone] = c.gone ? 1 : 0; out[at + PK.x] = c.x; out[at + PK.y] = 0; out[at + PK.angle] = 0;
        out[at + PK.lot] = -1; out[at + PK.archetype] = 1; out[at + PK.color] = 0x2f6a86;
      });
      return { whole, cars: out };
    };
    tick(client, [], told(true, [{ id: 1, x: 0 }, { id: 2, x: 10 }, { id: 3, x: 20 }]));
    const one = client.parked.find((v) => v.id === 1)!;
    expect(one.color).toBe('#2f6a86');
    const gone: number[] = [];
    client.onVehicleGone = (view) => gone.push(view.id);
    // A car told again is the same view, moved, and not told gone; 3 told gone.
    tick(client, [], told(false, [{ id: 1, x: 5 }, { id: 3, x: 0, gone: true }]));
    expect(client.parked.find((v) => v.id === 1)).toBe(one);
    expect(one.free).toMatchObject({ x: 5, lot: null });
    expect(client.parked.map((v) => v.id).sort()).toEqual([1, 2]);
    expect(gone).toEqual([3]);
    // Every car standing told: 2 not named is let go, 1 kept as it was, 4 made.
    tick(client, [], told(true, [{ id: 1, x: 6 }, { id: 4, x: 30 }]));
    expect(client.parked.map((v) => v.id).sort()).toEqual([1, 4]);
    expect(client.parked.find((v) => v.id === 1)).toBe(one);
    expect(client.vehiclesIn({ x0: 8, y0: -1, x1: 12, y1: 1 }, [], 'parked')).toEqual([]);
    // By cell, with a version that moves only where a parked car came, went or changed (`parkedCellsIn`).
    const far = 100_000;
    tick(client, [], told(false, [{ id: 7, x: far }]));
    const cells = (): Map<number, number> => new Map(client.parkedCellsIn({ x0: -far * 2, y0: -1, x1: far * 2, y1: 1 }, []).map((c) => [c.key, c.version]));
    const was = cells();
    expect(was.size).toBe(2);
    tick(client, [], told(false, [{ id: 7, x: far + 1 }]));
    const now = cells();
    const moved = [...was.keys()].filter((k) => now.get(k) !== was.get(k));
    expect(moved).toHaveLength(1);
    expect(client.parkedCellsIn({ x0: far, y0: -1, x1: far + 2, y1: 1 }, [])[0]!.key).toBe(moved[0]);
  });

  it("keeps a gesture's clock from the age it was told at, with no gesture told each tick", () => {
    const client = new SimClient(new RoadDoc());
    const data = inside(client).data;
    const ped = (age: number, rich: readonly (readonly [number, PedRich])[]): void => {
      data[headBase(0) + H.vehicles] = 0;
      data[headBase(0) + H.peds] = 1;
      const at = pedBase(0);
      data.fill(0, at, at + PED_STRIDE);
      data[at + P.id] = 9; data[at + P.age] = age; data[at + P.segment] = -1;
      const stats = { issues: [] } as unknown as SimStats;
      inside(client).receive({ type: 'tick', slot: 0, vehicles: [], peds: rich, signals: [], layout: null, trains: [], parked: null, stats, wounds: [], casualties: [] });
    };
    ped(10, [[9, { gesture: { kind: 'look', phase: 'hold', t: 1, hold: 4 } } as unknown as PedRich]]);
    expect(client.pedViews[0]!.gesture!.t).toBe(1);
    ped(12.5, []);
    expect(client.pedViews[0]!.gesture!.t).toBe(3.5);
  });

  it("keeps a junction's lights as last told, written into the map it has", () => {
    const client = new SimClient(new RoadDoc());
    const stats = { issues: [] } as unknown as SimStats;
    const told = (stage: string, state: 'red' | 'green'): void => {
      inside(client).data[headBase(0) + H.vehicles] = 0;
      inside(client).data[headBase(0) + H.peds] = 0;
      inside(client).receive({ type: 'tick', slot: 0, vehicles: [], peds: [], signals: [{ node: 5 as never, stage, states: [[1, state]] }], layout: null, trains: [], parked: null, stats, wounds: [], casualties: [] });
    };
    told('a', 'green');
    expect(client.signals.state(5 as never, 1)).toBe('green');
    told('b', 'red');
    expect(client.signals.state(5 as never, 1)).toBe('red');
    expect(client.signals.stage(5 as never)).toBe('b');
  });
});
