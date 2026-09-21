import { describe, expect, it } from 'vitest';

import {
  estimate,
  initial,
  next,
  reconnectMessage,
  reduce,
  type Event,
  type State,
} from '../src/onboarding';
import type { CapabilityReport } from '../src/capabilities';
import type { ValidationFailure } from '../src/archive/validate';

const usable: CapabilityReport = {
  capabilities: [],
  usable: true,
  blocking: [],
  warnings: [],
  mobile: false,
};

const unusable: CapabilityReport = {
  ...usable,
  usable: false,
  blocking: [{ name: 'WebGL2', ok: false, severity: 'blocking', remedy: 'Turn on hardware acceleration.' }],
};

const failure: ValidationFailure = {
  code: 'incomplete',
  title: 'That archive looks incomplete',
  detail: 'Let the launcher finish.',
  reportable: false,
};

/** The whole happy path, which is the exit criterion in one line. */
const firstVisit: Event[] = [
  { type: 'start' },
  { type: 'checked', report: usable },
  { type: 'file-chosen' },
  { type: 'validated', fingerprint: 'abc123' },
  { type: 'indexed', itemCount: 2426 },
];

describe('the first visit', () => {
  it('lands on a rendered catalogue', () => {
    const state = reduce(firstVisit);
    expect(state.stage).toBe('ready');
    expect(state.itemCount).toBe(2426);
    expect(state.fromCache).toBe(false);
  });

  it('shows progress only while indexing', () => {
    const indexing = reduce(firstVisit.slice(0, 4));
    expect(indexing.stage).toBe('indexing');
    const withProgress = next(indexing, {
      type: 'progress',
      progress: { step: 'item names', fraction: 0.5 },
    });
    expect(withProgress.progress?.step).toBe('item names');

    // A progress message arriving after the index finished must not drag the
    // flow back out of `ready`.
    const done = next(withProgress, { type: 'indexed', itemCount: 10 });
    const late = next(done, {
      type: 'progress',
      progress: { step: 'skeleton and poses', fraction: 0.9 },
    });
    expect(late.stage).toBe('ready');
    expect(late.progress).toBeUndefined();
  });

  it('blocks when a hard requirement is missing, and says how to fix it', () => {
    const state = reduce([{ type: 'start' }, { type: 'checked', report: unusable }]);
    expect(state.stage).toBe('blocked');
    expect(state.report?.blocking[0]?.remedy).toContain('hardware acceleration');
  });

  it('does not ask for a file before the check has run', () => {
    // A visitor who drops a file onto the landing page should not skip the
    // capability check, or they reach a broken viewer with no explanation.
    const state = next(initial, { type: 'file-chosen' });
    expect(state.stage).toBe('landing');
  });
});

describe('a file that will not do', () => {
  it('stops on the failure and offers a way back', () => {
    const rejected = reduce([
      { type: 'start' },
      { type: 'checked', report: usable },
      { type: 'file-chosen' },
      { type: 'file-rejected', failure },
    ]);
    expect(rejected.stage).toBe('invalid');
    expect(rejected.failure?.title).toContain('incomplete');

    const again = next(rejected, { type: 'retry' });
    expect(again.stage).toBe('awaiting-file');
    expect(again.failure).toBeUndefined();
  });

  it('will not retry out of a capability block', () => {
    // Nothing the visitor does on this page turns WebGL2 back on, so offering
    // a retry that lands them at a file picker would be a dead end.
    const blocked = reduce([{ type: 'start' }, { type: 'checked', report: unusable }]);
    expect(next(blocked, { type: 'retry' }).stage).toBe('blocked');
  });

  it('clears the old failure when a new file is chosen', () => {
    const state = reduce([
      { type: 'start' },
      { type: 'checked', report: usable },
      { type: 'file-chosen' },
      { type: 'file-rejected', failure },
      { type: 'retry' },
      { type: 'file-chosen' },
    ]);
    expect(state.stage).toBe('validating');
    expect(state.failure).toBeUndefined();
  });
});

describe('the return visit', () => {
  it('skips indexing entirely on a cache hit', () => {
    const state = reduce([
      { type: 'start' },
      { type: 'checked', report: usable },
      { type: 'file-chosen' },
      { type: 'catalogue-cached', fingerprint: 'abc123', itemCount: 2426 },
    ]);
    expect(state.stage).toBe('ready');
    expect(state.fromCache).toBe(true);
  });

  it('asks for the file again with a reason, and clears it on reconnect', () => {
    const ready = reduce(firstVisit);
    const asked = next(ready, { type: 'need-file', reason: 'uncached-piece' });
    expect(asked.stage).toBe('awaiting-file');
    expect(asked.reconnect).toBe('uncached-piece');

    const back = next(asked, { type: 'catalogue-cached', fingerprint: 'abc', itemCount: 1 });
    expect(back.reconnect).toBeUndefined();
  });

  it('does not call a default install an error', () => {
    // Most visitors have the game in Program Files, where no browser can keep
    // a handle. "Drop it again" is how it works, not a failure.
    expect(reconnectMessage('no-handle')).toContain('normal');
  });
});

describe('a game update', () => {
  const updated = reduce([
    ...firstVisit,
    { type: 'update-detected', fingerprint: 'new', staleFingerprint: 'abc123' },
  ]);

  it('offers the choice rather than rebuilding', () => {
    expect(updated.stage).toBe('update-available');
    expect(updated.staleFingerprint).toBe('abc123');
  });

  it('keeps the old catalogue usable when they decline', () => {
    const kept = next(updated, { type: 'keep-stale' });
    expect(kept.stage).toBe('ready');
    expect(kept.fingerprint).toBe('abc123');
  });

  it('rebuilds against the new build when they accept', () => {
    const rebuilt = next(updated, { type: 'rebuild' });
    expect(rebuilt.stage).toBe('indexing');
    expect(rebuilt.fingerprint).toBe('new');
    expect(rebuilt.staleFingerprint).toBeUndefined();
  });

  it('ignores a rebuild that was not offered', () => {
    const ready: State = reduce(firstVisit);
    expect(next(ready, { type: 'rebuild' }).stage).toBe('ready');
  });
});

describe('the estimate', () => {
  it('says nothing until there is enough history', () => {
    // A wrong ETA is worse than none, and the first few percent of a 158 GB
    // index are not representative of the rest.
    expect(estimate(0, 1000, 0.01)).toBeUndefined();
    expect(estimate(0, 1000, 0)).toBeUndefined();
  });

  it('extrapolates from elapsed time', () => {
    // A quarter done after 30s means about 90s left.
    expect(estimate(0, 30_000, 0.25)).toBe(90);
  });

  it('says nothing once finished', () => {
    expect(estimate(0, 30_000, 1)).toBeUndefined();
  });
});
