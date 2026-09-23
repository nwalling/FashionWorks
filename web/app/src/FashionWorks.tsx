/** The component Hangarworks embeds.
 *
 * It renders **all** of its own states -- capability checks, the file picker,
 * indexing progress, every error, and the kitbasher itself. The host is never
 * asked to render a spinner or an error page; that is the contract in
 * `WEB-INTEGRATION.md` §3, and it is what lets the route stay a static page
 * with no server code.
 *
 * It owns no colours. Everything comes from the host's `--sc-*` tokens, and
 * the 3D view re-reads them when `data-theme` changes -- which is the part CSS
 * cannot do for itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { checkCapabilities } from './capabilities';
import { ArchiveClient } from './archive/client';
import { readCatalogue, type Catalogue } from './archive/catalogue';
import { inspectFile } from './archive/validate';
import { initial, next, type Event, type State } from './onboarding';
import { Onboarding } from './ui/Onboarding';
import { Kitbasher } from './ui/Kitbasher';
import './ui/onboarding.css';
import { readTokens, watchTheme, type Tokens } from './theme';

export type FashionWorksErrorCode =
  | 'unsupported-browser'
  | 'no-webgl2'
  | 'not-a-p4k'
  | 'archive-unreadable'
  | 'unsupported-build'
  | 'storage-denied'
  | 'out-of-memory';

export interface FashionWorksProps {
  /** Applied to the root element. Use it to hand down your panel styling. */
  className?: string;
  /** Linked from error states, e.g. "/support" or a Discord invite. */
  supportHref?: string;
  /** Loadout to restore, from the URL fragment. Opaque string. */
  initialLoadout?: string;
  /** Fires when the loadout changes, debounced. Write it to the fragment. */
  onLoadoutChange?: (encoded: string) => void;
  /** Fires once the visitor has a working catalogue. Safe to log. */
  onReady?: (info: { itemCount: number; buildFingerprint: string }) => void;
  /** Fatal errors. Never contains file paths or anything identifying. */
  onError?: (error: { code: FashionWorksErrorCode; message: string }) => void;
}

/** Map an internal failure onto the host-facing code.
 *
 * The host's codes are deliberately coarser than the internal ones: a host
 * shows a support link and logs a counter, and does not need to know the
 * difference between a shortcut and a half-downloaded archive. The visitor
 * does, and gets it on screen.
 */
function errorCodeFor(state: State): FashionWorksErrorCode | null {
  if (state.stage === 'blocked') {
    const blocked = state.report?.blocking ?? [];
    return blocked.some((c) => c.name === 'WebGL2') ? 'no-webgl2' : 'unsupported-browser';
  }
  if (state.stage !== 'invalid' || !state.failure) return null;
  switch (state.failure.code) {
    case 'unsupported-build':
      return 'unsupported-build';
    case 'incomplete':
      return 'archive-unreadable';
    default:
      return 'not-a-p4k';
  }
}

export function FashionWorks(props: FashionWorksProps): JSX.Element {
  const { className, onReady, onError, initialLoadout, onLoadoutChange } = props;
  const [state, setState] = useState<State>(initial);
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The theme, read once and then on every change. Tokens live in state so the
  // 3D view re-renders with them; CSS needs none of this.
  useEffect(() => {
    setTokens(readTokens());
    return watchTheme(setTokens);
  }, []);

  const emit = useCallback((event: Event) => {
    setState((current) => next(current, event));
  }, []);

  const start = useCallback(async () => {
    emit({ type: 'start' });
    const report = await checkCapabilities();
    emit({ type: 'checked', report });
  }, [emit]);

  // The worker, and the catalogue it builds. One client per mounted component,
  // created on the first file rather than at mount, so a visitor who never gets
  // that far never pays for a worker or for the core it fetches.
  const client = useRef<ArchiveClient | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);

  useEffect(() => () => {
    client.current?.close();
    client.current = null;
  }, []);

  const onFile = useCallback((file: File) => {
    const problem = inspectFile(file);
    if (problem) {
      emit({ type: 'file-rejected', failure: problem });
      return;
    }
    // The archive is the worker's job from here. `validated` carries no
    // fingerprint yet -- the archive has not been read -- and the real one
    // arrives with `onIndexed`, a second or so later.
    emit({ type: 'validated', fingerprint: '' });

    client.current ??= new ArchiveClient();
    void client.current
      .open(file, 'male', {
        onProgress: ({ step, fraction }) => {
          emit({ type: 'progress', progress: { step, fraction } });
        },
        onIndexed: ({ fingerprint }) => {
          setState((current) => (current.stage === 'indexing'
            ? { ...current, fingerprint }
            : current));
        },
      })
      .then((opened) => {
        setCatalogue(readCatalogue(opened.catalogueJson));
        emit({ type: 'indexed', itemCount: opened.itemCount });
      })
      .catch((error: unknown) => {
        // A failure here is the archive, not the file's shape: `inspectFile`
        // already passed it. Reported as unreadable so the visitor is told to
        // check the file rather than told their browser is at fault.
        emit({
          type: 'file-rejected',
          failure: {
            code: 'incomplete',
            title: 'That archive could not be read',
            detail: error instanceof Error ? error.message : String(error),
            reportable: true,
          },
        });
      });
  }, [emit]);

  // Report state changes outward once, not on every render.
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    const code = errorCodeFor(state);
    if (code && code !== lastReported.current) {
      lastReported.current = code;
      onError?.({ code, message: state.failure?.title ?? 'This browser cannot run the tool' });
    }
    if (state.stage === 'ready' && lastReported.current !== 'ready') {
      lastReported.current = 'ready';
      onReady?.({
        itemCount: state.itemCount ?? 0,
        buildFingerprint: state.fingerprint ?? '',
      });
    }
  }, [state, onError, onReady]);

  const style = useMemo(() => ({
    // Only layout here. Every colour is a token the host already owns, applied
    // through the stylesheet rather than inline.
    display: 'flex',
    flexDirection: 'column' as const,
    // **A floor and a ceiling.** `min-height` alone is a floor: the root still
    // grew to fit its content, so the armour listing pushed the panel past the
    // bottom of the window, the listing never became the overflow point and so
    // never scrolled, and the 3D canvas inherited the oversized height and
    // framed the character below the fold. Every bound above this element --
    // the host's definite height, the flex chain, the grid row -- ended here.
    //
    // Both percentages resolve against a parent with a definite height, which
    // is what the contract asks a host for, and pin the root to exactly that.
    // Against a parent with only a `min-height` they are both ignored, so a
    // host that does not follow the contract gets the old behaviour rather
    // than a collapsed panel.
    minHeight: '100%',
    maxHeight: '100%',
  }), []);

  const ready = state.stage === 'ready' && tokens && catalogue && client.current;

  return (
    <div ref={root} className={className} style={style} data-fashionworks="">
      {/* Onboarding carries the visitor to `ready`, and then the kitbasher takes
          the whole panel: there is nothing left to say once the catalogue
          exists that the listing does not say better. */}
      {!ready && (
        <Onboarding
          state={state}
          onEvent={(event) => (event.type === 'start' ? void start() : emit(event))}
          onFile={onFile}
        />
      )}
      {/* Tokens are threaded rather than read again, so one observer serves the
          whole component, and a theme change restyles the scene without
          rebuilding it -- rebuilding would drop the armour. */}
      {ready && (
        <Kitbasher
          client={client.current!}
          catalogue={catalogue}
          tokens={tokens}
          initialLoadout={initialLoadout}
          onLoadoutChange={onLoadoutChange}
        />
      )}
    </div>
  );
}
