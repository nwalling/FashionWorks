import { afterEach, describe, expect, it, vi } from 'vitest';

/** A worker that answers any open with the rejection a file of zeroes gets:
 * one unprompted `failed`, the way the real worker reports it. */
vi.mock('../src/worker/archive.worker?worker&inline', () => ({
  default: class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(message: { type: string }) {
      if (message.type !== 'open' && message.type !== 'open-url') return;
      queueMicrotask(() => this.onmessage?.({
        data: { type: 'failed', message: 'reading central directory: end of central directory record not found' },
      }));
    }
    terminate() {}
  },
}));

// `openUrl` resolves its URL against the page, which Node does not have.
vi.stubGlobal('location', new URL('http://localhost:5183/'));

const { ArchiveClient } = await import('../src/archive/client');

/** Node's process, typed only as far as this needs: the package carries no
 * Node types. */
type Listener = (reason: unknown) => void;
const node = (globalThis as unknown as {
  process: { on(event: string, listener: Listener): void; off(event: string, listener: Listener): void };
}).process;

describe('opening an archive the worker rejects', () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  afterEach(() => {
    node.off('unhandledRejection', record);
    unhandled.length = 0;
  });

  for (const how of ['open', 'openUrl'] as const) {
    it(`${how} rejects once, and leaves no rejection unhandled`, async () => {
      node.on('unhandledRejection', record);
      const client = new ArchiveClient();
      const opening = how === 'open'
        ? client.open(new File([], 'Data.p4k'))
        : client.openUrl('/__p4k', 8 * 1024 ** 3);
      await expect(opening).rejects.toThrow(/central directory/);
      // Let any stray rejection surface before counting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    });
  }
});
