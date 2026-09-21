import { useRef, useState } from 'react';
import * as THREE from 'three';

import { shareUrl } from '../loadout';
import { useStore } from '../store';
import { exportCombinedGlb, exportLoadoutJson, exportScreenshot } from '../exporters';
import { BACKDROPS, type BackdropChoice } from './Backdrop';
import { REST_LABEL, REST_POSE } from '../three/poses';
import { HDR_PRESETS, type HdrPreset } from './Scene';

export function LoadoutBar({
  capture,
  preset,
  onPreset,
  backdrop,
  onBackdrop,
  customBackdrop,
  onCustomBackdrop,
  pose,
  onPose,
  wear,
  onWear,
}: {
  capture: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera } | null;
  preset: HdrPreset;
  onPreset: (preset: HdrPreset) => void;
  backdrop: BackdropChoice;
  onBackdrop: (backdrop: BackdropChoice) => void;
  customBackdrop: string | null;
  onCustomBackdrop: (file: File) => void;
  pose: string;
  onPose: (pose: string) => void;
  wear: boolean;
  onWear: (wear: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const manifest = useStore((state) => state.manifest);
  const poses = useStore((state) => state.poses);
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
      <select value={pose} title="Pose" onChange={(event) => onPose(event.target.value)}>
        <option value={REST_POSE}>{REST_LABEL}</option>
        {Object.entries(poses).map(([value, entry]) => (
          <option key={value} value={value}>
            {entry.label}
          </option>
        ))}
      </select>
      {/*
        Both surfaces are baked, so this swaps textures rather than
        recompositing. Wear is scuffing and bare-metal patches rather than a
        whole-surface change, so the difference is local: strong in the worn
        patches, invisible across a clean plate.
      */}
      <label className="toggle" title="Show armour scuffed, or as it left the factory">
        <input type="checkbox" checked={wear} onChange={(event) => onWear(event.target.checked)} />
        wear
      </label>
      <select
        value={backdrop}
        title="Backdrop behind the character"
        onChange={(event) => onBackdrop(event.target.value as BackdropChoice)}
      >
        {Object.keys(BACKDROPS).map((value) => (
          <option key={value} value={value}>
            {value === 'none' ? 'no backdrop' : value}
          </option>
        ))}
        {customBackdrop ? <option value="custom">your image</option> : null}
      </select>
      {/*
        Opening an image keeps it in the browser: it becomes an object URL and
        is never uploaded. Nothing here has a server to upload to, and these
        are the user's own screenshots.
      */}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onCustomBackdrop(file);
          // Let the same file be chosen again after it is cleared.
          event.target.value = '';
        }}
      />
      <button onClick={() => fileInput.current?.click()} title="Use an image from your computer">
        Background…
      </button>
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
