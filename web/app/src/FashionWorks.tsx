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
import { inspectFile } from './archive/validate';
import { initial, next, type Event, type State } from './onboarding';
import { Onboarding } from './ui/Onboarding';
import { Viewer } from './ui/Viewer';
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
  const { className, onReady, onError } = props;
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

  const onFile = useCallback((file: File) => {
    const problem = inspectFile(file);
    if (problem) {
      emit({ type: 'file-rejected', failure: problem });
      return;
    }
    // Indexing is the worker's job; this is the seam it plugs into.
    emit({ type: 'validated', fingerprint: '' });
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
    minHeight: '100%',
  }), []);

  return (
    <div ref={root} className={className} style={style} data-fashionworks="">
      <Onboarding
        state={state}
        onEvent={(event) => (event.type === 'start' ? void start() : emit(event))}
        onFile={onFile}
      />
      {/* The 3D view. Tokens are threaded rather than read again, so one
          observer serves the whole component, and a theme change restyles the
          scene without rebuilding it -- rebuilding would drop the armour. */}
      {state.stage === 'ready' && tokens ? <Viewer tokens={tokens} className="fw-view" /> : null}
    </div>
  );
}
