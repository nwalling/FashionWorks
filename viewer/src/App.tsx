import { useCallback, useEffect, useState } from 'react';
import * as THREE from 'three';

import { ManifestVersionError, loadManifest, selectableItems } from './manifest';
import { useStore } from './store';
import { LoadoutBar } from './components/LoadoutBar';
import { type BackdropChoice } from './components/Backdrop';
import { REST_POSE, loadPoses } from './three/poses';
import { Scene, type HdrPreset } from './components/Scene';
import { SlotPanel } from './components/SlotPanel';
import { TintPanel } from './components/TintPanel';

type Capture = { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera };

export function App() {
  const manifest = useStore((state) => state.manifest);
  const status = useStore((state) => state.status);
  const error = useStore((state) => state.error);
  const setManifest = useStore((state) => state.setManifest);
  const setError = useStore((state) => state.setError);
  const setLoading = useStore((state) => state.setLoading);
  const setPoses = useStore((state) => state.setPoses);

  const [capture, setCapture] = useState<Capture | null>(null);
  const [preset, setPreset] = useState<HdrPreset>('warehouse');
  const [backdrop, setBackdrop] = useState<BackdropChoice>('hangar');
  const [customBackdrop, setCustomBackdrop] = useState<string | null>(null);
  const [pose, setPose] = useState<string>('idle');

  const onReady = useCallback((state: Capture) => setCapture(state), []);

  // The image stays in the browser as an object URL; there is nowhere to
  // upload it to and no reason to. Revoke the previous one so opening several
  // in a row does not leak them.
  const onCustomBackdrop = useCallback((file: File) => {
    setCustomBackdrop((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
    setBackdrop('custom');
  }, []);

  useEffect(
    () => () => {
      if (customBackdrop) URL.revokeObjectURL(customBackdrop);
    },
    [customBackdrop],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading();
    loadPoses(controller.signal).then((library) => {
      // Effects run twice in development; the aborted pass resolves empty and
      // must not clobber the real library.
      if (controller.signal.aborted) return;
      setPoses(library);
      if (!library.idle) setPose(REST_POSE);
    });
    loadManifest(controller.signal)
      .then(setManifest)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          cause instanceof ManifestVersionError
            ? cause.message
            : `could not load the manifest: ${String(cause)}`;
        setError(message);
      });
    return () => controller.abort();
  }, [setManifest, setError, setLoading, setPoses]);

  if (status === 'error') {
    return (
      <div className="fatal">
        <h1>Nothing to show</h1>
        <p>{error}</p>
        <p className="hint">
          Generate assets first: <code>scx synth</code> for placeholders, or <code>scx all</code>{' '}
          against a Star Citizen install. Then <code>npm run link-assets</code>.
        </p>
      </div>
    );
  }

  const isSynthetic = manifest?.game_version.startsWith('synthetic') ?? false;

  return (
    <div className="app">
      <header>
        <h1>SC Armor Kitbasher</h1>
        <span className="version">
          {status === 'ready' ? manifest?.game_version : 'loading…'}
          {manifest ? ` · ${selectableItems(manifest).length} items` : ''}
        </span>
        {isSynthetic ? (
          <span className="badge">placeholder assets, not game data</span>
        ) : null}
      </header>

      <main>
        <div className="stage">
          <Scene
            preset={preset}
            backdrop={backdrop}
            customBackdrop={customBackdrop}
            pose={pose}
            onReady={onReady}
          />
        </div>
        <aside>
          <SlotPanel />
          <TintPanel />
        </aside>
      </main>

      <footer>
        <LoadoutBar
          capture={capture}
          preset={preset}
          onPreset={setPreset}
          backdrop={backdrop}
          onBackdrop={setBackdrop}
          customBackdrop={customBackdrop}
          onCustomBackdrop={onCustomBackdrop}
          pose={pose}
          onPose={setPose}
        />
      </footer>
    </div>
  );
}
