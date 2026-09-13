import { useState } from 'react';
import * as THREE from 'three';

import { shareUrl } from '../loadout';
import { useStore } from '../store';
import { exportCombinedGlb, exportLoadoutJson, exportScreenshot } from '../exporters';
import { BACKDROPS, type BackdropName } from './Backdrop';
import { HDR_PRESETS, type HdrPreset } from './Scene';

export function LoadoutBar({
  capture,
  preset,
  onPreset,
  backdrop,
  onBackdrop,
}: {
  capture: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera } | null;
  preset: HdrPreset;
  onPreset: (preset: HdrPreset) => void;
  backdrop: BackdropName;
  onBackdrop: (backdrop: BackdropName) => void;
}) {
  const manifest = useStore((state) => state.manifest);
  const loadout = useStore((state) => state.loadout);
  const past = useStore((state) => state.past);
  const future = useStore((state) => state.future);
  const undo = useStore((state) => state.undo);
  const redo = useStore((state) => state.redo);
  const clear = useStore((state) => state.clear);
  const randomize = useStore((state) => state.randomize);
  const save = useStore((state) => state.save);
  const restore = useStore((state) => state.restore);
  const [copied, setCopied] = useState(false);

  async function copyShareLink() {
    const url = shareUrl(loadout, window.location.href);
    window.history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="loadout-bar">
      <button onClick={undo} disabled={past.length === 0}>
        Undo
      </button>
      <button onClick={redo} disabled={future.length === 0}>
        Redo
      </button>
      <button onClick={randomize}>Randomize</button>
      <button onClick={clear}>Clear</button>
      <span className="spacer" />
      <button onClick={save}>Save</button>
      <button onClick={restore}>Restore</button>
      <span className="spacer" />
      <select
        value={backdrop}
        title="Backdrop behind the character"
        onChange={(event) => onBackdrop(event.target.value as BackdropName)}
      >
        {Object.keys(BACKDROPS).map((value) => (
          <option key={value} value={value}>
            {value === 'none' ? 'no backdrop' : value}
          </option>
        ))}
      </select>
      <select
        value={preset}
        title="Lighting environment"
        onChange={(event) => onPreset(event.target.value as HdrPreset)}
      >
        {HDR_PRESETS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <button onClick={() => exportLoadoutJson(loadout, manifest)}>Export JSON</button>
      <button
        onClick={() => (capture ? exportCombinedGlb(capture.scene) : undefined)}
        disabled={!capture}
      >
        Export GLB
      </button>
      <button
        onClick={() => (capture ? exportScreenshot(capture.gl, capture.scene, capture.camera) : undefined)}
        disabled={!capture}
      >
        Screenshot
      </button>
      <button onClick={copyShareLink}>{copied ? 'Copied' : 'Share link'}</button>
    </div>
  );
}
