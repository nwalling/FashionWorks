/** The portrait panel: the player's character in the outfit on screen, head
 * and shoulders, on a gradient, to download as an avatar.
 *
 * While it is open the viewport shows the portrait's light (the character
 * creator's rig) and, with the helmet toggled off, the bare head, so what is
 * on screen is what the picture shows; closing puts both back. The picture
 * is the visitor's own file. Nothing is uploaded and nothing asks for an
 * account (WEB-LEGAL.md): a host that wants it as an avatar has its own
 * picker.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { Kitbasher as Engine, KitbasherState } from '../three/kitbasher';
import {
  composePortrait,
  encodePortrait,
  portraitFileName,
  type PortraitBackground,
} from '../three/portrait';

export interface PortraitProps {
  readonly engine: Engine;
  readonly state: KitbasherState;
  /** Validated by `portraitBackgrounds`; the first is preselected. */
  readonly backgrounds: readonly PortraitBackground[];
  /** Open the character picker, for a visitor still on the default face. */
  readonly onLoadCharacter: () => void;
  readonly onClose: () => void;
}

/** The light a portrait is taken in: the customizer's own head-and-shoulders
 * rig (`three/lighting.ts`). */
const PORTRAIT_LIGHTING = 'creator';

/** How long the outfit has to sit still before the picture is taken again. */
const SETTLE_MS = 250;

/** How long a download's object URL is kept: `click()` only queues the
 * navigation, and revoking at once can lose the file (CLAUDE.md). */
const OBJECT_URL_TTL_MS = 60_000;

export function Portrait(props: PortraitProps): JSX.Element {
  const { engine, state, backgrounds, onLoadCharacter, onClose } = props;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const tiny = useRef<HTMLCanvasElement>(null);
  const [cutout, setCutout] = useState<OffscreenCanvas | null>(null);
  const [rendering, setRendering] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bare, setBare] = useState(false);
  // Held by id, so a host that changes the list (a theme switch) keeps the
  // pick while it is still offered and falls back to its first otherwise.
  const [picked, setPicked] = useState(backgrounds[0]!.id);
  const background = backgrounds.find((option) => option.id === picked) ?? backgrounds[0]!;
  const headGear = state.wearing.has('helmet') || state.wearing.has('hat');

  // The portrait's light while open, and the visitor's own back on close.
  useEffect(() => {
    const before = engine.current.lighting;
    if (before !== PORTRAIT_LIGHTING) void engine.setLighting(PORTRAIT_LIGHTING);
    return () => {
      engine.setBareHead(false);
      if (before && before !== PORTRAIT_LIGHTING) void engine.setLighting(before);
    };
  }, [engine]);

  useEffect(() => {
    engine.setBareHead(bare && headGear);
  }, [engine, bare, headGear]);

  // Taken again whenever what it shows changes: the outfit, the character,
  // the pose, the helmet. A newer request wins over an older one in flight.
  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    setRendering(true);
    const timer = setTimeout(() => {
      void engine.portrait().then((canvas) => {
        if (mine !== generation.current) return;
        setCutout(canvas);
        setFailed(!canvas);
        setRendering(false);
      }).catch(() => {
        if (mine !== generation.current) return;
        setFailed(true);
        setRendering(false);
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [engine, state.wearing, state.character, state.pose, state.body, state.wear, state.lighting, state.figure, bare]);

  // The previews: the picture as the clients crop it, large and at the size
  // of a member list, so the visitor can see the head reads at both.
  useEffect(() => {
    if (!cutout) return;
    for (const canvas of [preview.current, tiny.current]) {
      if (!canvas) continue;
      const scale = window.devicePixelRatio || 1;
      const size = Math.round(canvas.clientWidth * scale) || canvas.width;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.imageSmoothingQuality = 'high';
      context.drawImage(composePortrait(cutout, background, Math.max(size, 256)), 0, 0, size, size);
    }
  }, [cutout, background]);

  // Escape closes; focus starts in the panel and goes back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const download = useCallback(async () => {
    if (!cutout) return;
    setSaving(true);
    try {
      const blob = await encodePortrait(composePortrait(cutout, background));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = portraitFileName(state.character);
      // Attached first: Firefox ignores a click on a detached anchor.
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
    } finally {
      setSaving(false);
    }
  }, [cutout, background, state.character]);

  return (
    <div ref={panel} className="fw-kit-portrait" role="dialog" aria-labelledby={titleId}>
      <div className="fw-kit-portrait-head">
        <h2 id={titleId} className="fw-kit-portrait-title">Portrait</h2>
        <button type="button" aria-label="Close the portrait" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="fw-kit-portrait-previews" aria-busy={rendering}>
        <canvas ref={preview} className="fw-kit-portrait-preview" role="img" aria-label="The portrait, as an avatar crops it" />
        <canvas ref={tiny} className="fw-kit-portrait-tiny" role="img" aria-label="The portrait at the size of a member list" />
        {rendering && <span className="fw-kit-portrait-note">taking the picture…</span>}
        {!rendering && failed && <span className="fw-kit-portrait-note">the picture could not be taken</span>}
      </div>
      {!state.character && (
        <p className="fw-kit-portrait-hint">
          This is the default face.{' '}
          <button type="button" className="fw-kit-portrait-link" onClick={onLoadCharacter}>Load your character</button>
          {' '}to use your own.
        </p>
      )}
      {headGear && (
        <div className="fw-kit-more-row">
          <span className="fw-kit-label">helmet</span>
          <button type="button" aria-pressed={!bare} onClick={() => setBare(false)}>on</button>
          <button type="button" aria-pressed={bare} onClick={() => setBare(true)}>off</button>
        </div>
      )}
      {backgrounds.length > 1 && (
        <div className="fw-kit-portrait-backgrounds" role="radiogroup" aria-label="Background">
          {backgrounds.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === background.id}
              className="fw-kit-portrait-swatch"
              title={option.name}
              aria-label={option.name}
              style={{ background: `radial-gradient(circle at 50% 42%, ${option.from}, ${option.to})` }}
              onClick={() => setPicked(option.id)}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="fw-kit-portrait-save"
        disabled={!cutout || rendering || saving}
        onClick={() => void download()}
      >
        {saving ? 'saving…' : 'download'}
      </button>
    </div>
  );
}
