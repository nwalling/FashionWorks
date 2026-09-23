/** The kitbasher, as the component shows it once the catalogue exists.
 *
 * A listing down the side, the body in the middle, a strip of controls on
 * top. The DOM here is plain and the state comes from `Kitbasher` (the class),
 * which owns the scene objects and publishes what it is wearing and carrying.
 *
 * Colours are all tokens through `kitbasher.css`; nothing here has a hex value.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ArchiveClient } from '../archive/client';
import {
  colourwayName,
  displayName,
  GEAR_SLOTS,
  isGearSlot,
  lineKey,
  lineOf,
  lineRepresentative,
  lineTitle,
  swatchColour,
  SLOTS,
  type Catalogue,
  type CatalogueItem,
  type GearSlot,
  type Slot,
} from '../archive/catalogue';
import { portLabel, portServes, portShort } from '../gear/ports';
import { Kitbasher as Engine, type KitbasherState } from '../three/kitbasher';
import type { Tokens } from '../theme';
import { Viewer, type ViewerHandle } from './Viewer';
import './kitbasher.css';

/** How many rows to draw before asking for a search term.
 *
 * The listing is plain DOM, and a slot can hold hundreds of canonical pieces.
 * A virtual list would be the real answer; this is the honest placeholder.
 */
export const MAX_ROWS = 400;

/** Gear the hand can hold: the rest is thrown, loaded or injected. */
const HOLDABLE = new Set<string>(['primary', 'sidearm', 'knife', 'gadget']);

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

/** A row's title: the words its whole line shares -- "Defiance Core". */
function titleOfLine(catalogue: Catalogue, item: CatalogueItem): string {
  return lineTitle(lineOf(catalogue, item));
}

type Mode = 'armour' | 'gear';

/** What each pose button does, which with a weapon includes where it goes. */
const POSE_TITLES: Record<string, (holding: boolean) => string> = {
  rest: (holding) => `The skeleton's rest pose${holding ? '; the weapon goes back in its holster' : ''}`,
  idle: (holding) => (holding ? 'Stand at ease; the weapon goes back in its holster' : 'Stand at ease'),
  raised: (holding) => (holding ? 'Weapon raised' : 'Draw a holstered weapon and raise it'),
  crouch: (holding) => (holding ? 'Crouch with the weapon raised' : 'Crouch'),
};

export function Kitbasher(props: KitbasherProps): JSX.Element {
  const { client, catalogue: initialCatalogue, tokens, initialLoadout, onLoadoutChange, onEngine } = props;
  const engine = useRef<Engine | null>(null);
  const [state, setState] = useState<KitbasherState | null>(null);
  const [mode, setMode] = useState<Mode>('armour');
  const [armourSlot, setArmourSlot] = useState<Slot>('torso');
  const [gearSlot, setGearSlot] = useState<GearSlot>('primary');
  // The holster the next gear pick goes into; null picks the first free one.
  const [target, setTarget] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const viewer = useRef<ViewerHandle | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const slot: Slot | GearSlot = mode === 'armour' ? armourSlot : gearSlot;

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
      await built.setPose('idle');
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

  // The loadout, outward, whenever what is worn or carried changes.
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
  const carrying = state?.carrying ?? new Map<string, CatalogueItem>();
  // The engine rebuilds this on a body switch, so the listing follows it
  // rather than the prop it started from.
  const catalogue = state?.catalogue ?? initialCatalogue;

  // The holsters that serve the gear slot on screen, in the order the armour
  // declares them.
  const holsters = useMemo(() => (mode === 'gear'
    ? [...(state?.ports ?? new Map()).values()].filter((p) => portServes(p.port, gearSlot))
    : []), [mode, gearSlot, state?.ports]);

  // What the side panel's colour row is about: the armour piece in this slot,
  // or the gear in the targeted holster (else the first holster of this slot
  // that has anything in it).
  const onBody: CatalogueItem | undefined = mode === 'armour'
    ? wearing.get(armourSlot)
    : (target ? carrying.get(target) : undefined)
      ?? holsters.map((h) => carrying.get(h.port.name)).find(Boolean);
  const onBodyPort = mode === 'gear' && onBody
    ? [...carrying].find(([, item]) => item.id === onBody.id)?.[0] ?? null
    : null;

  // One row per product line: its colours and editions appear as swatches
  // above, rather than as twenty near-identical rows -- and a (Modified)
  // build is one of them too, whatever mesh it happens to use.
  const pool = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const seen = new Set<string>();
    const rows: CatalogueItem[] = [];
    const source = isGearSlot(slot) ? catalogue.gearBySlot.get(slot) : catalogue.bySlot.get(slot);
    for (const item of source ?? []) {
      const key = lineKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lineOf(catalogue, item);
      if (needle && !line.some((member) => (
        `${member.name ?? ''} ${member.class_name}`.toLowerCase().includes(needle)
      ))) continue;
      rows.push(lineRepresentative(line));
    }
    return rows.sort((a, b) => titleOfLine(catalogue, a).localeCompare(titleOfLine(catalogue, b)));
  }, [catalogue, slot, search]);

  const familyOf = (item: CatalogueItem) => lineOf(catalogue, item);
  const titleOf = (item: CatalogueItem) => titleOfLine(catalogue, item);

  const pick = (item: CatalogueItem, port: string | null = target) => {
    if (isGearSlot(item.slot)) void engine.current?.carry(item, port);
    else void engine.current?.equip(item);
  };

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
  // Work out the colours of the family on screen, for the pieces that carry no
  // tint palette. Only the visible family: compositing is real work, and the
  // catalogue has a thousand such pieces.
  const family = onBody ? lineOf(catalogue, onBody) : [];
  const familyKey = family.map((f) => f.id).join(',');
  useEffect(() => {
    for (const variant of family) {
      if (!swatchColour(variant) && !state?.swatches.has(variant.id)) {
        engine.current?.requestSwatch(variant);
      }
    }
    // `familyKey` rather than `family`: a new array every render would ask
    // again on every render, and the engine would have to dedupe a flood.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyKey, state?.swatches]);

  // A backdrop is the visitor's own file and never leaves the page; the object
  // URL is released when it is replaced, cleared, or the component goes.
  useEffect(() => () => { if (backdrop) URL.revokeObjectURL(backdrop); }, [backdrop]);

  // A target that no longer exists -- the armour carrying it came off -- is
  // forgotten rather than left pointing at nothing.
  useEffect(() => {
    if (target && !(state?.ports ?? new Map()).has(target)) setTarget(null);
  }, [target, state?.ports]);

  const busy = state?.busy ?? true;
  const poses = engine.current?.poseOptions() ?? ['rest', 'idle', 'crouch'];
  const holdable = [...carrying].filter(([, item]) => HOLDABLE.has(item.slot));
  const tabs = mode === 'armour' ? SLOTS : GEAR_SLOTS;
  const countOf = (name: string) => (isGearSlot(name)
    ? catalogue.gearBySlot.get(name)?.length
    : catalogue.bySlot.get(name as Slot)?.length) ?? 0;

  return (
    <div className="fw-kit" data-fashionworks-kitbasher="">
      <div className="fw-kit-bar" role="toolbar" aria-label="Slot, body, pose, surface, set and backdrop">
        {/* Armour or gear: the one control that decides what the slot tabs
            and the listing are about. Seven gear slots beside six armour ones
            would not fit a toolbar that already wraps. */}
        <span className="fw-kit-group" role="radiogroup" aria-label="What to browse">
          {(['armour', 'gear'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={mode === name}
              aria-pressed={mode === name}
              onClick={() => { setMode(name); setSearch(''); }}
            >
              {name}
            </button>
          ))}
        </span>
        {/* The slots live up here rather than in the sidebar: six chips took
            three rows of a narrow column, and that column's height is what the
            listing needs. The toolbar already wraps. */}
        <span className="fw-kit-group fw-kit-slots" role="tablist" aria-label="Slot">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={slot === name}
              onClick={() => {
                if (isGearSlot(name)) {
                  setGearSlot(name);
                  setTarget(null);
                } else {
                  setArmourSlot(name);
                }
              }}
            >
              {name} <span className="fw-kit-count">{countOf(name)}</span>
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
          {poses.map((pose) => (
            <button
              key={pose}
              type="button"
              aria-pressed={state?.pose === pose}
              disabled={busy}
              title={POSE_TITLES[pose]?.(Boolean(state?.holding))}
              onClick={() => void engine.current?.setPose(pose)}
            >
              {pose}
            </button>
          ))}
        </span>
        {holdable.length > 0 && (
          <span className="fw-kit-group" role="radiogroup" aria-label="In hand">
            <span className="fw-kit-label">hold</span>
            <button
              type="button"
              role="radio"
              aria-checked={!state?.holding}
              aria-pressed={!state?.holding}
              disabled={busy}
              onClick={() => void engine.current?.hold(null)}
            >
              nothing
            </button>
            {holdable.map(([port, item]) => (
              <button
                key={port}
                type="button"
                role="radio"
                aria-checked={state?.holding === port}
                aria-pressed={state?.holding === port}
                disabled={busy}
                title={`Hold the ${displayName(item)}, from the ${portLabel(state!.ports.get(port)!.port)} holster`}
                onClick={() => void engine.current?.hold(port)}
              >
                {titleOf(item)}
              </button>
            ))}
          </span>
        )}
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
          <button
            type="button"
            disabled={mode === 'armour' ? wearing.size === 0 : carrying.size === 0}
            title={mode === 'armour' ? 'Take all armour off' : 'Take all gear off'}
            onClick={() => (mode === 'armour' ? engine.current?.clear() : engine.current?.clearGear())}
          >
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
            placeholder={mode === 'armour'
              ? `Search ${catalogue.items.length.toLocaleString()} pieces…`
              : `Search ${catalogue.gear.length.toLocaleString()} pieces of gear…`}
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {mode === 'gear' && (() => {
            // Which holsters this slot's gear can go in, one line of short
            // chips: a filled one is marked, the targeted one is lit, and the
            // single × takes the targeted holster's item off. Two-line chips
            // with a × each stacked twelve magazine points five rows deep.
            const targeted = target ? carrying.get(target) : undefined;
            return (
              <div className="fw-kit-ports" role="radiogroup" aria-label="Holster">
                <span className="fw-kit-ports-label">
                  {holsters.length ? 'holsters' : `nothing worn has a holster for a ${gearSlot}`}
                </span>
                {holsters.map(({ port, owner }) => {
                  const inside = carrying.get(port.name);
                  return (
                    <button
                      key={port.name}
                      type="button"
                      role="radio"
                      className="fw-kit-port"
                      data-full={inside ? '' : undefined}
                      aria-checked={target === port.name}
                      aria-label={`${portLabel(port)}: ${inside ? displayName(inside) : 'empty'}`}
                      title={`${portLabel(port)}, on the ${owner}: ${inside ? displayName(inside) : 'empty'}`}
                      onClick={() => setTarget(target === port.name ? null : port.name)}
                    >
                      {portShort(port)}
                    </button>
                  );
                })}
                {target && targeted && (
                  <button
                    type="button"
                    className="fw-kit-port-remove"
                    aria-label={`Take the ${displayName(targeted)} off`}
                    title={`Take the ${displayName(targeted)} off`}
                    disabled={busy}
                    onClick={() => engine.current?.uncarry(target)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })()}
          {onBody && familyOf(onBody).length > 1 && (
            <div className="fw-kit-ways" role="radiogroup" aria-label="Color">
              {/* Labelled, because a row of small squares at the foot of a long
                  listing reads as decoration rather than as a control. */}
              <span className="fw-kit-ways-label">
                {/* In gear mode the holster chips no longer name what is in
                    them, so this says which piece the colours are for. */}
                {mode === 'gear' ? `${titleOf(onBody)} · ` : ''}{familyOf(onBody).length} colors
              </span>
              {familyOf(onBody).map((variant) => {
                const colour = swatchColour(variant) ?? state?.swatches.get(variant.id);
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
                    onClick={() => pick(variant, onBodyPort)}
                  />
                );
              })}
            </div>
          )}
          <div className="fw-kit-items" role="listbox" aria-label={`${slot} pieces`}>
            {pool.length === 0 && (
              <p className="fw-kit-empty">{search ? 'nothing matches' : 'nothing in this slot'}</p>
            )}
            {pool.slice(0, MAX_ROWS).map((item) => {
              const line = familyOf(item);
              const selected = mode === 'armour'
                ? Boolean(onBody && lineKey(onBody) === lineKey(item))
                : [...carrying.values()].some((c) => lineKey(c) === lineKey(item));
              const meta = [
                item.manufacturer?.code ?? '',
                item.weight_class ?? (item.attach?.size ? `size ${item.attach.size}` : ''),
                line.length > 1 ? `${line.length} colors` : '',
              ].filter(Boolean).join(' · ');
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="fw-kit-item"
                  disabled={busy}
                  onClick={() => pick(item)}
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
