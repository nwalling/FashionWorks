/** The onboarding flow, as a pure state machine.
 *
 * WEB.md's exit criterion for this phase is *"a first-time tester on a default
 * install gets from landing to a rendered set without help"*, and the thing
 * that decides whether that happens is not the visuals. It is whether every way
 * the flow can go wrong has somewhere to go. So the flow is a state machine
 * with the failures as states, kept pure -- events in, state out, no fetching,
 * no IndexedDB, no workers -- because that is what lets every error path be
 * exercised in a test rather than discovered by a visitor.
 *
 * The side effects live in the caller, which reads {@link next} and does what
 * the state asks for.
 */

import type { CapabilityReport } from './capabilities';
import type { ValidationFailure } from './archive/validate';

export type Stage =
  | 'landing'
  | 'checking'
  | 'blocked'
  | 'awaiting-file'
  | 'validating'
  | 'invalid'
  | 'indexing'
  | 'ready'
  | 'update-available';

/** The stages of a first index, in order, as WEB.md names them. */
export const INDEX_STEPS = [
  'reading archive index',
  'reading item database',
  'item names',
  'skeleton and poses',
] as const;

export type IndexStep = (typeof INDEX_STEPS)[number];

export interface Progress {
  readonly step: IndexStep;
  /** 0 to 1 within the whole index, not within the step. */
  readonly fraction: number;
  /** Seconds remaining, where there is enough history to say. */
  readonly etaSeconds?: number;
}

export interface State {
  readonly stage: Stage;
  readonly report?: CapabilityReport;
  readonly failure?: ValidationFailure;
  readonly progress?: Progress;
  /** The fingerprint in play, once known. */
  readonly fingerprint?: string;
  /** Set when a cached catalogue was found and used. */
  readonly fromCache?: boolean;
  /** On `update-available`: the catalogue still usable while they decide. */
  readonly staleFingerprint?: string;
  /** Why the visitor is being asked for the file again on a return visit. */
  readonly reconnect?: ReconnectReason;
  readonly itemCount?: number;
}

/** Why a returning visitor is being asked for `Data.p4k` again.
 *
 * Worth distinguishing, because the message differs and one of them is the
 * common case rather than an error: a default install cannot keep a handle at
 * all, so "drop it again" is simply how it works for most people and should not
 * read as a failure.
 */
export type ReconnectReason =
  | 'no-handle'        // the browser never could remember it
  | 'permission-lost'  // it could, and the grant expired
  | 'uncached-piece';  // everything is cached except what was just asked for

export type Event =
  | { type: 'start' }
  | { type: 'checked'; report: CapabilityReport }
  | { type: 'file-chosen' }
  | { type: 'file-rejected'; failure: ValidationFailure }
  | { type: 'validated'; fingerprint: string }
  | { type: 'catalogue-cached'; fingerprint: string; itemCount: number }
  | { type: 'progress'; progress: Progress }
  | { type: 'indexed'; itemCount: number }
  | { type: 'update-detected'; fingerprint: string; staleFingerprint: string }
  | { type: 'rebuild' }
  | { type: 'keep-stale' }
  | { type: 'need-file'; reason: ReconnectReason }
  | { type: 'retry' };

export const initial: State = { stage: 'landing' };

/** The next state. Unknown events for a stage leave it unchanged, which is what
 * keeps a late worker message from dragging the flow backwards. */
export function next(state: State, event: Event): State {
  switch (event.type) {
    case 'start':
      return { stage: 'checking' };

    case 'checked':
      return event.report.usable
        ? { stage: 'awaiting-file', report: event.report }
        : { stage: 'blocked', report: event.report };

    case 'file-chosen':
      // Only from a stage that is actually asking for one. A drop onto the
      // ready viewer is a different gesture and must not restart onboarding.
      if (state.stage !== 'awaiting-file') return state;
      return { ...state, stage: 'validating', failure: undefined };

    case 'file-rejected':
      return { ...state, stage: 'invalid', failure: event.failure };

    case 'validated':
      return { ...state, stage: 'indexing', fingerprint: event.fingerprint, failure: undefined };

    case 'catalogue-cached':
      // A cache hit skips indexing entirely; this is the return visit, and the
      // whole point of storing it.
      return {
        ...state,
        stage: 'ready',
        fingerprint: event.fingerprint,
        itemCount: event.itemCount,
        fromCache: true,
        reconnect: undefined,
      };

    case 'progress':
      if (state.stage !== 'indexing') return state;
      return { ...state, progress: event.progress };

    case 'indexed':
      return {
        ...state,
        stage: 'ready',
        itemCount: event.itemCount,
        progress: undefined,
        fromCache: false,
      };

    case 'update-detected':
      // The old catalogue stays usable while they decide, which is why this is
      // its own stage rather than an immediate rebuild.
      return {
        ...state,
        stage: 'update-available',
        fingerprint: event.fingerprint,
        staleFingerprint: event.staleFingerprint,
      };

    case 'rebuild':
      if (state.stage !== 'update-available') return state;
      return { ...state, stage: 'indexing', staleFingerprint: undefined, progress: undefined };

    case 'keep-stale':
      if (state.stage !== 'update-available') return state;
      // Carry on with what is already built. The prompt will come back next
      // visit, because the fingerprints still differ.
      return { ...state, stage: 'ready', fingerprint: state.staleFingerprint, fromCache: true };

    case 'need-file':
      return { ...state, stage: 'awaiting-file', reconnect: event.reason };

    case 'retry':
      // From a failure, back to asking. Capability blocks are not retryable
      // this way: nothing the visitor does on this page fixes a missing WebGL2,
      // so re-running the check is the caller's job and comes back as
      // `checked`.
      if (state.stage !== 'invalid') return state;
      return { ...state, stage: 'awaiting-file', failure: undefined };

    default:
      return state;
  }
}

/** Run a sequence of events. Handy in tests, and in replaying a session. */
export function reduce(events: readonly Event[], from: State = initial): State {
  return events.reduce(next, from);
}

/** What the visitor is told while a first index runs.
 *
 * Step boundaries come from the worker; the ETA is smoothed here because a raw
 * per-message estimate on a 158 GB archive jumps around enough to look broken.
 */
export function estimate(
  startedAt: number,
  now: number,
  fraction: number,
): number | undefined {
  // Below a twentieth there is not enough history for an honest number, and a
  // wrong ETA is worse than none.
  if (fraction <= 0.05 || fraction >= 1) return undefined;
  const elapsed = (now - startedAt) / 1000;
  if (elapsed <= 0) return undefined;
  return Math.max(1, Math.round(elapsed * (1 / fraction - 1)));
}

/** What to say when a returning visitor has to produce the file again. */
export function reconnectMessage(reason: ReconnectReason): string {
  switch (reason) {
    case 'no-handle':
      return 'Drop Data.p4k again to load new pieces. Your browser cannot remember the file '
        + 'between visits, so this is normal.';
    case 'permission-lost':
      return 'Reconnect to Data.p4k to load new pieces.';
    case 'uncached-piece':
      return 'That piece has not been loaded before. Drop Data.p4k to fetch it.';
  }
}
