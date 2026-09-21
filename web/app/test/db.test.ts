import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  CATALOGUE_VERSION,
  DEFAULT_SETTINGS,
  deleteCatalogue,
  getCatalogue,
  getSettings,
  listCatalogues,
  open,
  putCatalogue,
  putSettings,
  type CachedCatalogue,
} from '../src/storage/db';

function entry(fingerprint: string, extra: Partial<CachedCatalogue> = {}): CachedCatalogue {
  return {
    fingerprint,
    version: CATALOGUE_VERSION,
    builtAt: Date.now(),
    itemCount: 2426,
    items: [{ id: 'x' }],
    ...extra,
  };
}

describe('the catalogue cache', () => {
  beforeEach(() => {
    // A fresh origin per test; otherwise one test's catalogue is another's.
    globalThis.indexedDB = new IDBFactory();
  });

  it('gives back what was stored', async () => {
    const db = await open();
    await putCatalogue(db, entry('abc'));
    const found = await getCatalogue(db, 'abc');
    expect(found?.itemCount).toBe(2426);
  });

  it('keys on the fingerprint, so two builds coexist', async () => {
    // A visitor who switches between LIVE and PTU keeps both catalogues and
    // pays the index cost once each, not once per switch.
    const db = await open();
    await putCatalogue(db, entry('live', { channel: 'LIVE', itemCount: 2426 }));
    await putCatalogue(db, entry('ptu', { channel: 'PTU', itemCount: 2500 }));
    expect((await getCatalogue(db, 'live'))?.itemCount).toBe(2426);
    expect((await getCatalogue(db, 'ptu'))?.itemCount).toBe(2500);
    expect(await listCatalogues(db)).toHaveLength(2);
  });

  it('refuses a catalogue written by an older shape', async () => {
    // The manifest already taught this: a reader that trusts a version it
    // cannot actually read is worse than one that rebuilds.
    const db = await open();
    await putCatalogue(db, entry('old', { version: CATALOGUE_VERSION - 1 }));
    expect(await getCatalogue(db, 'old')).toBeUndefined();
  });

  it('reports a miss rather than throwing', async () => {
    const db = await open();
    expect(await getCatalogue(db, 'never-seen')).toBeUndefined();
  });

  it('forgets a catalogue on request', async () => {
    const db = await open();
    await putCatalogue(db, entry('abc'));
    await deleteCatalogue(db, 'abc');
    expect(await getCatalogue(db, 'abc')).toBeUndefined();
  });

  it('lists newest first', async () => {
    const db = await open();
    await putCatalogue(db, entry('older', { builtAt: 1000 }));
    await putCatalogue(db, entry('newer', { builtAt: 2000 }));
    expect((await listCatalogues(db)).map((c) => c.fingerprint)).toEqual(['newer', 'older']);
  });
});

describe('settings', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('start at their defaults', async () => {
    const db = await open();
    expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trip', async () => {
    const db = await open();
    await putSettings(db, { ...DEFAULT_SETTINGS, bodyType: 'female', wear: false });
    const found = await getSettings(db);
    expect(found.bodyType).toBe('female');
    expect(found.wear).toBe(false);
  });

  it('fill in a field added after they were written', async () => {
    // A returning visitor's stored settings predate any field added later. If
    // those arrived undefined the viewer would read `wear` as false and quietly
    // render every piece unworn.
    const db = await open();
    await putSettings(db, { bodyType: 'female' } as never);
    const found = await getSettings(db);
    expect(found.bodyType).toBe('female');
    expect(found.wear).toBe(DEFAULT_SETTINGS.wear);
    expect(found.cacheCap).toBe(DEFAULT_SETTINGS.cacheCap);
  });
});
