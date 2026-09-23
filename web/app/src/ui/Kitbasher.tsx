/** The kitbasher, as the component shows it once the catalogue exists.
 *
 * A listing down the side, the body in the middle, a strip of controls on
 * top. The DOM here is plain and the state comes from `Kitbasher` (the class),
 * which owns the scene objects and publishes what it is wearing.
 *
 * Colours are all tokens through `kitbasher.css`; nothing here has a hex value.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ArchiveClient } from '../archive/client';
import {
  colourwayName,
  displayName,
  familyRoot,
  sharedName,
  SLOTS,
  type Catalogue,
  type CatalogueItem,
  type Slot,
} from '../archive/catalogue';
import { Kitbasher as Engine, POSES, type KitbasherState } from '../three/kitbasher';
import type { Tokens } from '../theme';
import { Viewer, type ViewerHandle } from './Viewer';
import './kitbasher.css';

/** How many rows to draw before asking for a search term.
 *
 * The listing is plain DOM, and a slot can hold hundreds of canonical pieces.
 * A virtual list would be the real answer; this is the honest placeholder.
 */
export const MAX_ROWS = 400;

export interface KitbasherProps {
  readonly client: ArchiveClient;
  readonly catalogue: Catalogue;
  readonly tokens: Tokens;
  /** Loadout to restore, from the URL fragment. Opaque string. */
  readonly initialLoadout?: string;
  /** Fires when the loadout changes. Write it to the fragment. */
  readonly onLoadoutChange?: (encoded: string) => void;
  /** Called once the engine exists, for a verification page to drive it. */
  readonly onEngine?: (engine: Engine) => void;
}

export function Kitbasher(props: KitbasherProps): JSX.Element {
  const { client, catalogue: initialCatalogue, tokens, initialLoadout, onLoadoutChange, onEngine } = props;
  const engine = useRef<Engine | null>(null);
  const [state, setState] = useState<KitbasherState | null>(null);
  const [slot, setSlot] = useState<Slot>('torso');
  const [search, setSearch] = useState('');
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const viewer = useRef<ViewerHandle | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // The engine is built once the scene exists, and torn down with the view.
  const onScene = useCallback((handle: ViewerHandle) => {
    viewer.current = handle;
    const built = new Engine(client, initialCatalogue, handle);
    engine.current = built;
    onEngine?.(built);
    const unsubscribe = built.subscribe(setState);
    void (async () => {
      await built.init();
      if (initialLoadout) {
        const restored = await built.restore(initialLoadout);
        if (restored) return;
      }
      // Open on something rather than an empty grid.
      const torsos = initialCatalogue.bySlot.get('torso') ?? [];
      const opener = torsos.find((i) => displayName(i).includes('Sunchaser'))
        ?? torsos.find((i) => !i.variant_of);
      if (opener) await built.equip(opener);
      await built.setPose(POSES[1]!);
    })();
    // Returned for symmetry; the Viewer never calls this back, so the engine
    // is disposed from the unmount effect below instead.
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, by design
  }, []);

  useEffect(() => () => {
    engine.current?.dispose();
    engine.current = null;
  }, []);

  // The loadout, outward, whenever what is worn changes.
  const lastLoadout = useRef<string | null>(null);
  useEffect(() => {
    if (!state || !engine.current) return;
    const encoded = engine.current.loadout();
    if (encoded !== lastLoadout.current) {
      lastLoadout.current = encoded;
      onLoadoutChange?.(encoded);
    }
  }, [state, onLoadoutChange]);

  const wearing = state?.wearing ?? new Map<Slot, CatalogueItem>();
  const onBody = wearing.get(slot);
  // The engine rebuilds this on a body switch, so the listing follows it
  // rather than the prop it started from.
  const catalogue = state?.catalogue ?? initialCatalogue;

  // Canonical pieces only: a family's colourways appear as swatches below,
  // rather than as twenty near-identical rows.
  const pool = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (catalogue.bySlot.get(slot) ?? []).filter((item) => {
      if (item.variant_of) return false;
      if (!needle) return true;
      return `${item.name ?? ''} ${item.class_name}`.toLowerCase().includes(needle);
    });
  }, [catalogue, slot, search]);

  const familyOf = (item: CatalogueItem) => catalogue.families.get(familyRoot(item)) ?? [item];
  const titleOf = (item: CatalogueItem) => sharedName(familyOf(item).map(displayName));

  const chooseBackdrop = (file: File | undefined) => {
    if (!file) return;
    if (backdrop) URL.revokeObjectURL(backdrop);
    const url = URL.createObjectURL(file);
    setBackdrop(url);
    viewer.current?.setBackdrop(url);
  };
  const clearBackdrop = () => {
    if (backdrop) URL.revokeObjectURL(backdrop);
    setBackdrop(null);
    viewer.current?.setBackdrop(null);
  };
  // A backdrop is the visitor's own file and never leaves the page; the object
  // URL is released when it is replaced, cleared, or the component goes.
  useEffect(() => () => { if (backdrop) URL.revokeObjectURL(backdrop); }, [backdrop]);

  const busy = state?.busy ?? true;

  return (
    <div className="fw-kit" data-fashionworks-kitbasher="">
      <div className="fw-kit-bar" role="toolbar" aria-label="Slot, body, pose, surface, set and backdrop">
        {/* The slots live up here rather than in the sidebar: six chips took
            three rows of a narrow column, and that column's height is what the
            armour listing needs. The toolbar already wraps. */}
        <span className="fw-kit-group fw-kit-slots" role="tablist" aria-label="Slot">
          {SLOTS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={slot === name}
              onClick={() => setSlot(name)}
            >
              {name} <span className="fw-kit-count">{catalogue.bySlot.get(name)?.length ?? 0}</span>
            </button>
          ))}
        </span>
        <span className="fw-kit-group">
          <span className="fw-kit-label">body</span>
          {(['male', 'female'] as const).map((body) => (
            <button
              key={body}
              type="button"
              aria-pressed={(state?.body ?? 'male') === body}
              disabled={busy}
              title={`Show armour on the ${body} body`}
              onClick={() => void engine.current?.setBody(body)}
            >
              {body}
            </button>
          ))}
        </span>
        <span className="fw-kit-group">
          <span className="fw-kit-label">pose</span>
          {POSES.map((pose) => (
            <button
              key={pose.label}
              type="button"
              aria-pressed={state?.pose === pose.label}
              disabled={busy}
              onClick={() => void engine.current?.setPose(pose)}
            >
              {pose.label}
            </button>
          ))}
        </span>
        <span className="fw-kit-group">
          <span className="fw-kit-label">surface</span>
          <button
            type="button"
            aria-pressed={state?.wear ?? true}
            disabled={busy}
            title="Worn in, or as it left the factory"
            onClick={() => void engine.current?.setWear(!(state?.wear ?? true))}
          >
            {state?.wear === false ? 'factory' : 'worn'}
          </button>
        </span>
        <span className="fw-kit-group">
          <button
            type="button"
            disabled={busy || wearing.size === 0}
            title="Fill the empty slots to match the piece on the torso"
            onClick={() => void engine.current?.equipSet()}
          >
            equip set
          </button>
          <button type="button" disabled={wearing.size === 0} onClick={() => engine.current?.clear()}>
            clear
          </button>
        </span>
        <span className="fw-kit-group">
          <span className="fw-kit-label">backdrop</span>
          <button type="button" onClick={() => picker.current?.click()}>choose…</button>
          <button type="button" disabled={!backdrop} onClick={clearBackdrop}>none</button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => chooseBackdrop(event.target.files?.[0])}
          />
        </span>
      </div>

      <div className="fw-kit-body">
        <aside className="fw-kit-side">
          <input
            className="fw-kit-search"
            type="search"
            placeholder={`Search ${catalogue.items.length.toLocaleString()} pieces…`}
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="fw-kit-items" role="listbox" aria-label={`${slot} pieces`}>
            {pool.length === 0 && (
              <p className="fw-kit-empty">{search ? 'nothing matches' : 'nothing in this slot'}</p>
            )}
            {pool.slice(0, MAX_ROWS).map((item) => {
              const family = familyOf(item);
              const selected = Boolean(onBody && familyRoot(onBody) === familyRoot(item));
              const meta = [
                item.manufacturer?.code ?? '',
                item.weight_class ?? '',
                family.length > 1 ? `${family.length} colourways` : '',
              ].filter(Boolean).join(' · ');
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="fw-kit-item"
                  disabled={busy}
                  onClick={() => void engine.current?.equip(item)}
                >
                  <span className="fw-kit-item-name">{titleOf(item)}</span>
                  <span className="fw-kit-item-meta">{meta}</span>
                </button>
              );
            })}
            {pool.length > MAX_ROWS && (
              <p className="fw-kit-empty">…and {pool.length - MAX_ROWS} more; search to narrow</p>
            )}
          </div>
          {onBody && familyOf(onBody).length > 1 && (
            <div className="fw-kit-ways" role="radiogroup" aria-label="Colourway">
              {/* Labelled, because a row of small squares at the foot of a long
                  listing reads as decoration rather than as a control. */}
              <span className="fw-kit-ways-label">
                {familyOf(onBody).length} colourways
              </span>
              {familyOf(onBody).map((variant) => {
                const colour = variant.tint?.layers?.[0]?.color;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    role="radio"
                    aria-checked={onBody.id === variant.id}
                    className="fw-kit-way"
                    style={colour ? { background: colour } : undefined}
                    title={colourwayName(displayName(variant), titleOf(variant))}
                    disabled={busy}
                    onClick={() => void engine.current?.equip(variant)}
                  />
                );
              })}
            </div>
          )}
        </aside>

        <div className="fw-kit-stage">
          <Viewer tokens={tokens} onScene={onScene} className="fw-view fw-kit-view" />
          <p className="fw-kit-status">
            <span aria-live="polite">{state?.status ?? 'starting…'}</span>
            {/* The host's fan-site notice sits above the tool, and the tool now
                takes the whole window -- so that notice is scrolled out of
                sight for as long as anyone actually uses this. Carrying the
                attribution here keeps it on screen. It is a condition of the
                fan-content go-ahead (WEB-LEGAL.md), not decoration. */}
            <span className="fw-kit-attribution">
              Not affiliated with or endorsed by Cloud Imperium Games.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
