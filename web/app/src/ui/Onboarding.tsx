/** The onboarding flow, rendered.
 *
 * Presentational and driven entirely by {@link State}: it takes a state and an
 * event sink and holds nothing of its own except the drag highlight. That is
 * what lets every screen -- including the four failure screens a visitor should
 * never see -- be put on screen in a test by handing it a state.
 *
 * Styling is deliberately minimal and uses the `--sc-*` tokens Hangarworks
 * already defines, with fallbacks so this renders standalone. Phase 5 does the
 * real theming; nothing here should need rewriting for it, only restyling.
 */

import { useCallback, useRef, useState } from 'react';

import type { Capability, CapabilityReport } from '../capabilities';
import { formatBytes, inspectFile } from '../archive/validate';
import {
  INDEX_STEPS,
  reconnectMessage,
  type Event,
  type State,
} from '../onboarding';

/** Where Star Citizen puts itself, per channel. Offered for copying, because a
 * web page cannot open a folder or pre-fill a path -- handing over the text is
 * the most it can do. */
export const DEFAULT_PATHS: Record<string, string> = {
  LIVE: 'C:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE',
  PTU: 'C:\\Program Files\\Roberts Space Industries\\StarCitizen\\PTU',
  EPTU: 'C:\\Program Files\\Roberts Space Industries\\StarCitizen\\EPTU',
  'TECH-PREVIEW': 'C:\\Program Files\\Roberts Space Industries\\StarCitizen\\TECH-PREVIEW',
};

export interface OnboardingProps {
  readonly state: State;
  readonly onEvent: (event: Event) => void;
  /** Called with a file that passed the cheap checks. The caller indexes it. */
  readonly onFile: (file: File) => void;
}

export function Onboarding({ state, onEvent, onFile }: OnboardingProps) {
  return (
    <section className="fw-onboarding" aria-live="polite">
      {state.stage === 'landing' && <Landing onEvent={onEvent} />}
      {state.stage === 'checking' && <p className="fw-muted">Checking your browser…</p>}
      {state.stage === 'blocked' && <Blocked report={state.report} />}
      {(state.stage === 'awaiting-file' || state.stage === 'invalid') && (
        <PickFile state={state} onEvent={onEvent} onFile={onFile} />
      )}
      {state.stage === 'validating' && <p className="fw-muted">Reading the archive…</p>}
      {state.stage === 'indexing' && <Indexing state={state} />}
      {state.stage === 'update-available' && <UpdateAvailable onEvent={onEvent} />}
      {state.stage === 'ready' && <Ready state={state} />}
    </section>
  );
}

function Landing({ onEvent }: { onEvent: (event: Event) => void }) {
  return (
    <div>
      <h2>Kitbash Star Citizen FPS armour</h2>
      {/* The single most important sentence on the page. Visitors will assume
          choosing a 158 GB file means uploading it, and will not choose it. */}
      <p className="fw-promise">
        Runs entirely on your PC. Your game files are never uploaded.
      </p>
      <ul className="fw-requirements">
        <li>Star Citizen installed</li>
        <li>A desktop browser — Chrome or Edge recommended, Firefox supported</li>
        <li>A few GB of free disk space</li>
      </ul>
      <button type="button" className="fw-primary" onClick={() => onEvent({ type: 'start' })}>
        Get started
      </button>
      <p className="fw-fineprint">
        Not affiliated with or endorsed by Cloud Imperium Games.
      </p>
    </div>
  );
}

function Blocked({ report }: { report?: CapabilityReport }) {
  const blocking = report?.blocking ?? [];
  return (
    <div>
      <h2>This browser cannot run the tool</h2>
      {blocking.map((c) => (
        <div key={c.name} className="fw-problem">
          <strong>{c.name}</strong>
          <p>{c.remedy}</p>
        </div>
      ))}
      {/* Warnings are shown here too: a blocked visitor who fixes the blocker
          should not then meet a second surprise. */}
      <CapabilityList capabilities={report?.capabilities ?? []} />
    </div>
  );
}

function CapabilityList({ capabilities }: { capabilities: readonly Capability[] }) {
  if (capabilities.length === 0) return null;
  return (
    <ul className="fw-checks">
      {capabilities.map((c) => (
        <li key={c.name} className={c.ok ? 'fw-ok' : `fw-${c.severity}`}>
          <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {c.name}
          {!c.ok && c.remedy ? <span className="fw-muted"> — {c.remedy}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function PickFile({ state, onEvent, onFile }: OnboardingProps) {
  const [dragging, setDragging] = useState(false);
  const [channel, setChannel] = useState('LIVE');
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      onEvent({ type: 'file-chosen' });
      // The cheap checks run before anything is read, so the commonest
      // mistakes -- a shortcut, an .exe, a half-downloaded archive -- come back
      // instantly instead of after an index.
      const problem = inspectFile(file);
      if (problem) {
        onEvent({ type: 'file-rejected', failure: problem });
        return;
      }
      onFile(file);
    },
    [onEvent, onFile],
  );

  return (
    <div>
      <h2>Point to your Data.p4k</h2>

      {state.reconnect && <p className="fw-notice">{reconnectMessage(state.reconnect)}</p>}

      {state.stage === 'invalid' && state.failure && (
        <div className="fw-problem" role="alert">
          <strong>{state.failure.title}</strong>
          <p>{state.failure.detail}</p>
          {state.failure.reportable && (
            <p>
              <a href="https://discord.gg/hangarworks" target="_blank" rel="noreferrer noopener">
                Report it on Discord
              </a>
            </p>
          )}
          <button type="button" onClick={() => onEvent({ type: 'retry' })}>
            Try another file
          </button>
        </div>
      )}

      {/* Drag-and-drop is the primary path and not a nicety: Chromium's
          blocklist refuses every File System Access picker under Program Files,
          which is exactly where Star Citizen installs. Drag-and-drop and a
          plain file input are not subject to that list. */}
      <div
        className={dragging ? 'fw-drop fw-drop-active' : 'fw-drop'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files[0]);
        }}
      >
        <p className="fw-droptitle">Drag Data.p4k here</p>
        <p className="fw-muted">
          Your browser reads only the parts it needs. Nothing is uploaded, which is why a
          158 GB file opens instantly.
        </p>
        <button type="button" onClick={() => input.current?.click()}>
          Choose file
        </button>
        <input
          ref={input}
          type="file"
          accept=".p4k"
          hidden
          onChange={(e) => accept(e.target.files?.[0])}
        />
      </div>

      <details className="fw-help">
        <summary>Help me find it</summary>
        <label>
          Channel{' '}
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {Object.keys(DEFAULT_PATHS).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <code className="fw-path">{DEFAULT_PATHS[channel]}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(DEFAULT_PATHS[channel] ?? '').then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <p className="fw-muted">
          Paste this into the File Explorer address bar, then drag <code>Data.p4k</code> onto
          this page.
        </p>
        <p className="fw-muted">
          Installed somewhere else? The RSI Launcher’s settings show your library folder.
        </p>
      </details>
    </div>
  );
}

function Indexing({ state }: { state: State }) {
  const progress = state.progress;
  const current = progress ? INDEX_STEPS.indexOf(progress.step) : 0;
  return (
    <div>
      <h2>Reading your game files</h2>
      <p className="fw-muted">This happens once per game build. You can keep this tab open.</p>
      <ol className="fw-steps">
        {INDEX_STEPS.map((step, i) => (
          <li key={step} className={i < current ? 'fw-done' : i === current ? 'fw-current' : ''}>
            {step}
          </li>
        ))}
      </ol>
      <progress value={progress?.fraction ?? 0} max={1} />
      {progress?.etaSeconds !== undefined && (
        <p className="fw-muted">About {formatSeconds(progress.etaSeconds)} left</p>
      )}
    </div>
  );
}

function UpdateAvailable({ onEvent }: { onEvent: (event: Event) => void }) {
  return (
    <div>
      <h2>Star Citizen was updated</h2>
      {/* The old catalogue stays usable while they decide. Rebuilding without
          asking would take the tool away for two minutes with no warning. */}
      <p>
        Your saved catalogue was built from an earlier game build. You can keep using it, or
        rebuild it from the version you have now.
      </p>
      <button type="button" className="fw-primary" onClick={() => onEvent({ type: 'rebuild' })}>
        Rebuild the catalogue
      </button>
      <button type="button" onClick={() => onEvent({ type: 'keep-stale' })}>
        Keep using the old one
      </button>
    </div>
  );
}

function Ready({ state }: { state: State }) {
  return (
    <div>
      <h2>Ready</h2>
      <p>
        {state.itemCount?.toLocaleString()} pieces
        {state.fromCache ? ' loaded from your saved catalogue' : ' catalogued'}.
      </p>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export { formatBytes };
