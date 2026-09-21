import { describe, expect, it } from 'vitest';

import {
  ARMOUR_PREFIX,
  formatBytes,
  inspectFile,
  MINIMUM_BYTES,
  REQUIRED_ENTRIES,
  validateArchive,
  type IndexedArchive,
} from '../src/archive/validate';

/** A stand-in for the wasm `Archive`, so every failure path is reachable
 * without a 158 GB file. */
function archive(options: {
  entries?: number;
  present?: readonly string[];
  armour?: number;
} = {}): IndexedArchive {
  const present = options.present ?? REQUIRED_ENTRIES;
  return {
    entryCount: () => options.entries ?? 1_365_842,
    hasEntry: (path) => present.includes(path),
    countUnder: (prefix) => (prefix === ARMOUR_PREFIX ? options.armour ?? 7004 : 0),
    fingerprint: () => 'deadbeefdeadbeef',
  };
}

describe('a first look at the file', () => {
  const good = { name: 'Data.p4k', size: 147.59 * 1024 ** 3 };

  it('passes the real thing', () => {
    expect(inspectFile(good)).toBeNull();
  });

  it('names the file they actually picked', () => {
    const wrong = inspectFile({ name: 'StarCitizen.exe', size: 1024 ** 3 });
    expect(wrong?.code).toBe('wrong-file');
    // The message has to contain the name, or a visitor who dragged the wrong
    // thing from a folder of similar files cannot tell which one it means.
    expect(wrong?.title).toContain('StarCitizen.exe');
  });

  it('recognises a shortcut as an empty file', () => {
    const empty = inspectFile({ name: 'Data.p4k', size: 0 });
    expect(empty?.code).toBe('wrong-file');
    expect(empty?.detail).toContain('shortcut');
  });

  it('tells a partial download to finish downloading', () => {
    const partial = inspectFile({ name: 'Data.p4k', size: MINIMUM_BYTES - 1 });
    expect(partial?.code).toBe('incomplete');
    expect(partial?.detail).toContain('Launcher');
    // And it says how big theirs is, so they can see it is growing.
    expect(partial?.detail).toContain('GB');
  });

  it('never tells the visitor to report a file they picked wrong', () => {
    // Discord is for build problems. A wrong file is theirs to fix and saying
    // "report this" would send a stream of non-bugs.
    for (const file of [
      { name: 'foo.txt', size: 10 },
      { name: 'Data.p4k', size: 0 },
      { name: 'Data.p4k', size: 1024 },
    ]) {
      expect(inspectFile(file)?.reportable).toBe(false);
    }
  });
});

describe('an indexed archive', () => {
  it('accepts the real build and returns its fingerprint', () => {
    const result = validateArchive(archive());
    expect(result.code).toBe('ok');
    if (result.code === 'ok') {
      expect(result.fingerprint).toBe('deadbeefdeadbeef');
      expect(result.entryCount).toBe(1_365_842);
    }
  });

  it('rejects a file that opened but holds nothing', () => {
    expect(validateArchive(archive({ entries: 0 })).code).toBe('not-an-archive');
  });

  it('calls a missing DataCore an unsupported build, and asks for a report', () => {
    const result = validateArchive(
      archive({ present: ['Data\\Localization\\english\\global.ini'] }),
    );
    expect(result.code).toBe('unsupported-build');
    if (result.code !== 'ok') {
      expect(result.detail).toContain('Game2.dcb');
      // This one *is* worth reporting: it means a patch moved something.
      expect(result.reportable).toBe(true);
    }
  });

  it('names both missing files when both are gone', () => {
    const result = validateArchive(archive({ present: [] }));
    if (result.code !== 'ok') {
      expect(result.detail).toContain('Game2.dcb');
      expect(result.detail).toContain('global.ini');
      expect(result.detail).toContain('are');
    }
  });

  it('catches a valid archive with no armour in it', () => {
    // Structurally fine, nothing to show. Without this the visitor waits
    // through a full index and arrives at an empty catalogue.
    const result = validateArchive(archive({ armour: 3 }));
    expect(result.code).toBe('unsupported-build');
    if (result.code !== 'ok') expect(result.detail).toContain('3 armour files');
  });
});

describe('formatting a size', () => {
  it('reads the way a person would say it', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(147.59 * 1024 ** 3)).toBe('148 GB');
  });
});
