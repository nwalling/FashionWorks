/** Every onboarding screen, side by side, including the ones a visitor should
 * never see.
 *
 * The failure screens are the ones worth looking at: they are rare by
 * definition, so they are the screens that ship broken. Here they are all on
 * one page, driven straight from the state machine, so a layout that overflows
 * or a message that reads like a stack trace is visible without having to
 * reproduce a half-downloaded 158 GB archive.
 *
 * It also runs the real flow against a real file, so drag-and-drop and the file
 * input are exercised rather than assumed.
 */

import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './src/ui/onboarding.css';
import { Onboarding } from './src/ui/Onboarding';
import { checkCapabilities, type CapabilityReport } from './src/capabilities';
import { initial, next, type Event, type State } from './src/onboarding';

const usable: CapabilityReport = {
  capabilities: [
    { name: 'WebAssembly', ok: true, severity: 'blocking' },
    { name: 'WebGL2', ok: true, severity: 'blocking' },
  ],
  usable: true,
  blocking: [],
  warnings: [],
  mobile: false,
};

const noWebGl: CapabilityReport = {
  capabilities: [
    { name: 'WebAssembly', ok: true, severity: 'blocking' },
    {
      name: 'WebGL2',
      ok: false,
      severity: 'blocking',
      remedy: 'Turn on hardware acceleration in your browser settings, or update your graphics driver.',
    },
    {
      name: 'Quick reconnect',
      ok: false,
      severity: 'warning',
      remedy: 'Your browser cannot remember the file, so you will drop Data.p4k again next time.',
    },
  ],
  usable: false,
  blocking: [
    {
      name: 'WebGL2',
      ok: false,
      severity: 'blocking',
      remedy: 'Turn on hardware acceleration in your browser settings, or update your graphics driver.',
    },
  ],
  warnings: [],
  mobile: false,
};

/** One named state per screen, so the gallery covers the whole machine. */
const SCREENS: Record<string, State> = {
  landing: initial,
  checking: { stage: 'checking' },
  'blocked (no WebGL2)': { stage: 'blocked', report: noWebGl },
  'awaiting a file': { stage: 'awaiting-file', report: usable },
  'reconnect (default install)': {
    stage: 'awaiting-file',
    report: usable,
    reconnect: 'no-handle',
  },
  'reconnect (uncached piece)': {
    stage: 'awaiting-file',
    report: usable,
    reconnect: 'uncached-piece',
  },
  'wrong file': {
    stage: 'invalid',
    report: usable,
    failure: {
      code: 'wrong-file',
      title: 'That is StarCitizen.exe, not Data.p4k',
      detail: 'Look for the file called exactly "Data.p4k" in your StarCitizen\\LIVE folder. '
        + 'It is the largest file there.',
      reportable: false,
    },
  },
  'incomplete download': {
    stage: 'invalid',
    report: usable,
    failure: {
      code: 'incomplete',
      title: 'That archive looks incomplete',
      detail: 'Data.p4k is well over 100 GB and this one is 4.2 GB. If the RSI Launcher is '
        + 'still downloading or verifying, let it finish and try again.',
      reportable: false,
    },
  },
  'unsupported build': {
    stage: 'invalid',
    report: usable,
    failure: {
      code: 'unsupported-build',
      title: 'This game build is not supported yet',
      detail: 'The archive opened and indexed 1,365,842 files, but Game2.dcb is not where this '
        + 'tool expects. That usually means Star Citizen moved something in a patch. Please '
        + 'report it in the Hangarworks Discord with your game version.',
      reportable: true,
    },
  },
  validating: { stage: 'validating', report: usable },
  'indexing (early)': {
    stage: 'indexing',
    report: usable,
    progress: { step: 'reading archive index', fraction: 0.08, etaSeconds: 95 },
  },
  'indexing (late)': {
    stage: 'indexing',
    report: usable,
    progress: { step: 'skeleton and poses', fraction: 0.86, etaSeconds: 12 },
  },
  'game updated': {
    stage: 'update-available',
    report: usable,
    fingerprint: 'new',
    staleFingerprint: 'old',
  },
  ready: { stage: 'ready', report: usable, itemCount: 2426, fromCache: false },
  'ready (from cache)': { stage: 'ready', report: usable, itemCount: 2426, fromCache: true },
};

function Gallery() {
  return (
    <div style={{ display: 'grid', gap: 24, padding: 24, background: '#0a1219' }}>
      <h1 style={{ color: '#eaf2f6', font: '600 16px system-ui', margin: 0 }}>
        Onboarding: every screen
      </h1>
      {Object.entries(SCREENS).map(([name, state]) => (
        <div key={name}>
          <p style={{ color: '#9fb6c2', font: '600 12px ui-monospace, monospace', margin: '0 0 6px' }}>
            {name}
          </p>
          <Onboarding state={state} onEvent={() => {}} onFile={() => {}} />
        </div>
      ))}
    </div>
  );
}

/** The real flow, wired to the real capability check and a stubbed index.
 *
 * The index is stubbed because the worker is not built yet; everything before
 * it -- the check, the drop, the cheap validation, the failure screens -- is
 * the genuine article.
 */
function Live() {
  const [state, setState] = useState<State>(initial);
  const [log, setLog] = useState<string[]>([]);

  const onEvent = useCallback((event: Event) => {
    setLog((l) => [...l, event.type]);
    setState((s) => next(s, event));
  }, []);

  const start = useCallback(async () => {
    onEvent({ type: 'start' });
    const report = await checkCapabilities();
    onEvent({ type: 'checked', report });
  }, [onEvent]);

  const onFile = useCallback(
    (file: File) => {
      setLog((l) => [...l, `accepted ${file.name} (${file.size} bytes)`]);
      onEvent({ type: 'validated', fingerprint: 'stub' });
      let fraction = 0;
      const steps = ['reading archive index', 'reading item database', 'item names', 'skeleton and poses'] as const;
      const timer = setInterval(() => {
        fraction += 0.12;
        if (fraction >= 1) {
          clearInterval(timer);
          onEvent({ type: 'indexed', itemCount: 2426 });
          return;
        }
        onEvent({
          type: 'progress',
          progress: {
            step: steps[Math.min(steps.length - 1, Math.floor(fraction * steps.length))]!,
            fraction,
            etaSeconds: Math.round((1 - fraction) * 60),
          },
        });
      }, 400);
    },
    [onEvent],
  );

  return (
    <div style={{ padding: 24, background: '#0a1219', minHeight: '100vh' }}>
      <h1 style={{ color: '#eaf2f6', font: '600 16px system-ui', margin: '0 0 12px' }}>
        Onboarding: the live flow
      </h1>
      <Onboarding
        state={state}
        onEvent={(e) => (e.type === 'start' ? void start() : onEvent(e))}
        onFile={onFile}
      />
      <pre style={{ color: '#9fb6c2', font: '12px ui-monospace, monospace', marginTop: 16 }}>
        stage: {state.stage}
        {'\n'}
        {log.join('\n')}
      </pre>
    </div>
  );
}

const live = new URLSearchParams(location.search).has('live');
(window as unknown as { __screens: string[] }).__screens = Object.keys(SCREENS);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{live ? <Live /> : <Gallery />}</StrictMode>,
);
