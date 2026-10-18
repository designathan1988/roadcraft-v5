import { afterEach, describe, expect, it, vi } from 'vitest';

/** THE DERIVED CACHE'S WRITES DO NOT WAIT FOR THE DISK (`durability: 'relaxed'`, MDN IDBDatabase.transaction): what it keeps is made again if lost; the player's saves and the tiles (`editor/saveStore.ts`) keep the default */

/** An IndexedDB that answers at once and keeps each transaction's mode and options. */
function fakeIndexedDb(): { readonly api: unknown; readonly transactions: { readonly mode: string; readonly options: unknown; readonly puts: string[] }[] } {
  const transactions: { mode: string; options: unknown; puts: string[] }[] = [];
  const request = (): { onerror: null; onsuccess: null } => ({ onerror: null, onsuccess: null });
  const db = {
    objectStoreNames: { contains: () => true },
    onversionchange: null, onclose: null, close: () => {},
    transaction(_store: string, mode: string, options?: unknown) {
      const puts: string[] = [];
      transactions.push({ mode, options, puts });
      const tx = { oncomplete: null as (() => void) | null, onabort: null, onerror: null,
        objectStore: () => ({ put: (_value: unknown, key: string) => { puts.push(key); return request(); }, delete: request }) };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  const api = {
    open: () => {
      const opening = { result: db, onsuccess: null as (() => void) | null, onerror: null, onblocked: null, onupgradeneeded: null };
      setTimeout(() => opening.onsuccess?.(), 0);
      return opening;
    },
  };
  return { api, transactions };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("the derived cache's writes", () => {
  it('are relaxed, each kind of them', async () => {
    const fake = fakeIndexedDb();
    vi.stubGlobal('indexedDB', fake.api);
    vi.resetModules();
    const cache = await import('@core/derivedCache');
    const { committed } = await cache.keepDerivedDurably('far:1', { a: 1 });
    await committed;
    await cache.keepDerivedQueuedMany([['far:2', { a: 2 }], ['far:2b', { a: 3 }]], new cache.WriteBudget(1024));
    await cache.keepDerivedMany('roads:', new Map([['k', 1]]));
    await cache.keepDerivedManyCommitted('roads:', new Map([['k', 2]]));
    cache.writeDerived('far:3', 3);
    cache.forgetDerivedKeys('roads:', ['k']);
    await new Promise((done) => setTimeout(done, 0));
    const writes = fake.transactions.filter((t) => t.mode === 'readwrite');
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const t of writes) expect(t.options).toEqual({ durability: 'relaxed' });
  });

  it("are not the tiles' or the saves' (their store opens its own database and keeps the default)", async () => {
    const { readFileSync } = await import('node:fs');
    const saves = readFileSync('src/editor/saveStore.ts', 'utf8');
    expect(saves).not.toMatch(/durability/);
    expect(saves).not.toMatch(/roadcraft-derived/);
  });
});

describe("a tile's far levels kept by its maker", () => {
  it('go in one transaction, every key of them, not one commit a key', async () => {
    const fake = fakeIndexedDb();
    vi.stubGlobal('indexedDB', fake.api);
    vi.resetModules();
    const cache = await import('@core/derivedCache');
    await cache.keepDerivedQueuedMany([['m:t', 1], ['m:t:plate', 2], ['m:t:boxes', 3], ['r:t', 4]], new cache.WriteBudget(1024));
    const writes = fake.transactions.filter((t) => t.mode === 'readwrite');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.puts).toEqual(['m:t', 'm:t:plate', 'm:t:boxes', 'r:t']);
  });

  it("are gathered from its bakes in the maker's worker, then kept in one call", async () => {
    const { readFileSync } = await import('node:fs');
    const worker = readFileSync('src/cityTile.worker.ts', 'utf8');
    const keepFar = worker.slice(worker.indexOf('async function keepFar('), worker.indexOf('/** The streamed tile built'));
    expect(keepFar).toMatch(/keepTileFar\(.*into\.far\)/);
    expect(keepFar).toMatch(/keepTileNearBuildings\(.*into\.near\)/);
    expect(keepFar.match(/keepDerivedQueuedMany\(/g)).toHaveLength(1);
  });
});

