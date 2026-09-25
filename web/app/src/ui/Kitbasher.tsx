/** The kitbasher, as the component shows it once the catalogue exists.
 *
 * LAYOUT.md. A column down the side holds everything the mode switch
 * changes: the mode, the slot tiles, the listing, equip set and clear. Over
 * the body sit two overlays: the scene cluster (body, light, quality, More)
 * at the top right, and the pose dock at the bottom. The DOM here is plain and the state comes from `Kitbasher` (the class),
 * which owns the scene objects and publishes what it is wearing and carrying.
 *
 * Colours are all tokens through `kitbasher.css`; nothing here has a hex value.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

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
  CLOTHING_SLOTS,
  SLOTS,
  type Catalogue,
  type CatalogueItem,
  type ClothingSlot,
  type GearSlot,
  type WearSlot,
} from '../archive/catalogue';
import { HAND, portLabel, portServes, portShort } from '../gear/ports';
import { Kitbasher as Engine, type KitbasherState } from '../three/kitbasher';
import { HEAD_SLOTS } from '../three/outfit';
import type { Tokens } from '../theme';
import { QUALITIES, Viewer, type Quality, type ViewerHandle } from './Viewer';
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

/** What the listing is about. Armour and clothing are also the outfit on the
 * body: the game makes them exclusive, so browsing one puts it on, and the
 * other is kept aside until it comes back. CLOTHING.md Phase 3. */
type Mode = 'armour' | 'clothing' | 'gear';

/** A slot as a person would say it; the ids are the catalogue's. */
const SLOT_LABELS: Partial<Record<string, string>> = {
  accessory: 'torso accessory',
  pack: 'backpack',
};

const slotLabel = (slot: string) => SLOT_LABELS[slot] ?? slot;

/** The lighting preset a visitor last chose. Per-visitor convenience only:
 * storage can be blocked or empty, and the default is always fine. */
const LIGHT_KEY = 'fashionworks:lighting';

function rememberedLighting(): string | null {
  try {
    return localStorage.getItem(LIGHT_KEY);
  } catch {
    return null;
  }
}

function rememberLighting(id: string): void {
  try {
    localStorage.setItem(LIGHT_KEY, id);
  } catch {
    // Blocked storage: the choice lasts for this visit only.
  }
}

const FIGURE_KEY = 'fashionworks:figure';

/** Whether the visitor last turned the figure off. On unless they did. */
function rememberedFigure(): boolean {
  try {
    return localStorage.getItem(FIGURE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function rememberFigure(on: boolean): void {
  try {
    localStorage.setItem(FIGURE_KEY, on ? 'on' : 'off');
  } catch {
    // As for lighting.
  }
}

/** The width at and below which the stage sits over the column, the tiles
 * are chips and the scene controls fold into one button. `kitbasher.css`
 * uses the same number. */
const NARROW = '(max-width: 720px)';

/** Whether the page is at `NARROW`, kept current as the window changes. */
function useNarrow(): boolean {
  const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW).matches;
  const [narrow, setNarrow] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(NARROW);
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return narrow;
}

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
  const [armourSlot, setArmourSlot] = useState<WearSlot>('torso');
  const [clothingSlot, setClothingSlot] = useState<ClothingSlot>('shirt');
  const [gearSlot, setGearSlot] = useState<GearSlot>('primary');
  // The holster the next gear pick goes into; null picks the first free one.
  const [target, setTarget] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const viewer = useRef<ViewerHandle | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const chfPicker = useRef<HTMLInputElement>(null);
  const narrow = useNarrow();
  // The More popover: a disclosure. It closes on Escape, on a click outside,
  // and on More again -- never on a control inside it being used, since
  // someone flipping surface wants to see the result and flip it back.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const moreButton = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      moreButton.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!sceneRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [moreOpen]);
  const slot: WearSlot | GearSlot = mode === 'armour' ? armourSlot : mode === 'clothing' ? clothingSlot : gearSlot;

  // The engine is built once the scene exists, and torn down with the view.
  const onScene = useCallback((handle: ViewerHandle) => {
    viewer.current = handle;
    setQuality(handle.quality());
    const built = new Engine(client, initialCatalogue, handle);
    // Low draws the baked atlas; everything above runs LayerBlend on the mesh.
    void built.setSurfaceMode(handle.quality() === 'low' ? 'baked' : 'live');
    const remembered = rememberedLighting();
    if (remembered) void built.setLighting(remembered);
    if (!rememberedFigure()) built.setFigure(false);
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

  const wearing = state?.wearing ?? new Map<WearSlot, CatalogueItem>();

  // The listing follows the outfit on the body: a share link that opens on
  // clothing, or a piece of the other outfit equipped by a check, switches it.
  const outfit = state?.outfit;
  useEffect(() => {
    if (outfit) setMode((current) => (current === 'gear' ? current : outfit));
  }, [outfit]);
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
  const onBody: CatalogueItem | undefined = mode !== 'gear'
    ? wearing.get(slot as WearSlot)
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
  const lighting = engine.current?.lightingOptions() ?? [];
  const holdable = [...carrying].filter(([, item]) => HOLDABLE.has(item.slot));
  const countOf = (name: string) => (isGearSlot(name)
    ? catalogue.gearBySlot.get(name)?.length
    : catalogue.bySlot.get(name as WearSlot)?.length) ?? 0;
  // A clothing slot this build has nothing for is left out rather than shown
  // empty: every torso accessory in 4.10 is a `<= PLACEHOLDER =>` record.
  // The head's slots are offered with armour too: a hat or glasses go on with
  // it wherever no helmet covers them, as in the game.
  const tabs: readonly string[] = mode === 'armour'
    ? [...SLOTS, ...HEAD_SLOTS.filter((name) => countOf(name) > 0)]
    : mode === 'clothing' ? CLOTHING_SLOTS.filter((name) => countOf(name) > 0) : GEAR_SLOTS;
  const searchable = mode === 'gear'
    ? catalogue.gear.length
    : tabs.reduce((sum, name) => sum + countOf(name), 0);
  const choose = (next: Mode) => {
    setMode(next);
    setSearch('');
    if (next !== 'gear') void engine.current?.setOutfit(next);
  };

  const modeSwitch = (
    // Armour, clothing or gear: the one control that decides what the slot
    // tiles and the listing are about, so it heads the column it rewrites.
    // Armour and clothing are also the outfit on the body, since the game
    // allows only one.
    <div className="fw-kit-modes" role="radiogroup" aria-label="What to browse">
      {(['armour', 'clothing', 'gear'] as const).map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={mode === name}
          aria-pressed={mode === name}
          disabled={busy && name !== 'gear' && mode !== name}
          title={name === 'gear'
            ? 'Weapons and equipment, into the holsters of what is worn'
            : `Wear ${name}; the ${name === 'armour' ? 'clothing' : 'armour'} is kept aside`}
          onClick={() => choose(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );

  // What a tile's second line says: the piece worn in the slot, or for gear
  // what is carried for it, `+N` when several are (magazines often are).
  const wornIn = (name: string): { line: string; more: string; full: string } | null => {
    if (isGearSlot(name)) {
      const carried = [...carrying.values()].filter((i) => i.slot === name);
      if (!carried.length) return null;
      const more = carried.length > 1 ? ` +${carried.length - 1}` : '';
      return { line: titleOf(carried[0]!), more, full: carried.map(displayName).join(', ') };
    }
    const worn = wearing.get(name as WearSlot);
    return worn ? { line: titleOf(worn), more: '', full: displayName(worn) } : null;
  };

  const tiles = (
    // The slots as tiles: each is the tab for its slot and shows what is worn
    // there, so the whole outfit is readable without looking at the body.
    <div className="fw-kit-tiles" role="tablist" aria-label="Slot">
      {tabs.map((name) => {
        const worn = wornIn(name);
        const count = countOf(name);
        return (
          <button
            key={name}
            type="button"
            role="tab"
            className="fw-kit-tile"
            aria-selected={slot === name}
            aria-label={`${slotLabel(name)}, ${count} ${count === 1 ? 'piece' : 'pieces'}, ${worn ? `wearing ${worn.full}` : 'empty'}`}
            title={worn?.full}
            onClick={() => {
              if (isGearSlot(name)) {
                setGearSlot(name);
                setTarget(null);
              } else if (mode === 'clothing') {
                setClothingSlot(name as ClothingSlot);
              } else {
                setArmourSlot(name as WearSlot);
              }
            }}
          >
            <span className="fw-kit-tile-head">
              <span className="fw-kit-tile-slot">{slotLabel(name)}</span>
              <span className="fw-kit-count">{count}</span>
            </span>
            <span className="fw-kit-tile-worn" data-empty={worn ? undefined : ''}>
              <span className="fw-kit-tile-name">{worn?.line ?? 'empty'}</span>
              {worn?.more && <span className="fw-kit-tile-more">{worn.more}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );

  // The other outfit, kept aside: says what the exclusive-outfit model is
  // doing better than the mode button's title can.
  const asideCount = state?.aside.size ?? 0;
  const asideNote = mode !== 'gear' && asideCount > 0 && (
    <p className="fw-kit-aside">
      {mode === 'armour' ? 'clothing' : 'armour'} kept aside: {asideCount} {asideCount === 1 ? 'piece' : 'pieces'}
    </p>
  );

  const bodySwitch = (
    <span className="fw-kit-group" role="group" aria-label="Body">
      <span className="fw-kit-label">body</span>
      {(['male', 'female'] as const).map((body) => (
        <button
          key={body}
          type="button"
          aria-pressed={(state?.body ?? 'male') === body}
          disabled={busy}
          title={`Dress the ${body} body`}
          onClick={() => void engine.current?.setBody(body)}
        >
          {body}
        </button>
      ))}
    </span>
  );

  const lightSelect = lighting.length > 0 && (
    <span className="fw-kit-group">
      <span className="fw-kit-label">light</span>
      <select
        className="fw-kit-select"
        aria-label="Lighting"
        value={state?.lighting ?? ''}
        onChange={(event) => {
          const id = event.target.value;
          rememberLighting(id);
          void engine.current?.setLighting(id);
        }}
      >
        {lighting.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </span>
  );

  const qualitySelect = quality && (
    <span className="fw-kit-group">
      <span className="fw-kit-label">quality</span>
      <select
        className="fw-kit-select"
        aria-label="Render quality"
        title="Low draws straight to the screen; medium and high add ambient occlusion; the percentages draw more pixels than the display has"
        value={quality}
        onChange={(event) => {
          const next = event.target.value as Quality;
          viewer.current?.setQuality(next);
          setQuality(next);
          void engine.current?.setSurfaceMode(next === 'low' ? 'baked' : 'live');
        }}
      >
        {QUALITIES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </span>
  );

  // Set once, if ever: behind More.
  const moreRows = (
    <>
      <div className="fw-kit-more-row">
        <span className="fw-kit-label">figure</span>
        <button
          type="button"
          aria-pressed={state?.figure ?? true}
          title="Draw the body and head under what is worn, or what is worn alone"
          onClick={() => {
            const next = !(state?.figure ?? true);
            rememberFigure(next);
            engine.current?.setFigure(next);
          }}
        >
          figure
        </button>
      </div>
      <div className="fw-kit-more-row">
        <span className="fw-kit-label">character</span>
        {/* A player's own face, from the file the game's customizer saves.
            It is read here, in the browser, and goes nowhere. */}
        <button
          type="button"
          aria-pressed={Boolean(state?.character)}
          disabled={busy}
          title={state?.character
            ? `${state.character}: load another character`
            : 'Load your character: the .chf the game saves in StarCitizen/LIVE/user/client/0/CustomCharacters. It stays in this browser.'}
          onClick={() => chfPicker.current?.click()}
        >
          {state?.character ?? 'character…'}
        </button>
        {state?.character && (
          <button
            type="button"
            aria-label="Back to the default face"
            title="Back to the default face"
            disabled={busy}
            onClick={() => void engine.current?.clearCharacter()}
          >
            ×
          </button>
        )}
        <input
          ref={chfPicker}
          type="file"
          accept=".chf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void file.arrayBuffer().then((buffer) => engine.current?.loadCharacter(
              new Uint8Array(buffer),
              file.name.replace(/\.chf$/i, ''),
            ));
          }}
        />
      </div>
      <div className="fw-kit-more-row">
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
      </div>
      <div className="fw-kit-more-row">
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
      </div>
    </>
  );

  return (
    <div className="fw-kit" data-fashionworks-kitbasher="">
      <div className="fw-kit-body">
        <aside className="fw-kit-side">
          {modeSwitch}
          {tiles}
          {asideNote}
          <input
            className="fw-kit-search"
            type="search"
            placeholder={mode === 'gear'
              ? `Search ${searchable.toLocaleString()} pieces of gear…`
              : `Search ${searchable.toLocaleString()} pieces of ${mode}…`}
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
          <div className="fw-kit-items" role="listbox" aria-label={`${slotLabel(slot)} pieces`}>
            {pool.length === 0 && (
              <p className="fw-kit-empty">{search ? 'nothing matches' : 'nothing in this slot'}</p>
            )}
            {pool.slice(0, MAX_ROWS).map((item) => {
              const line = familyOf(item);
              const selected = mode !== 'gear'
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
          <div className="fw-kit-foot">
            <button
              type="button"
              disabled={busy || wearing.size === 0}
              title={mode === 'clothing'
                ? 'Fill the empty slots from the same clothing line'
                : 'Fill the empty slots to match the piece on the torso'}
              onClick={() => void engine.current?.equipSet()}
            >
              equip set
            </button>
            <button
              type="button"
              disabled={mode === 'gear' ? carrying.size === 0 : wearing.size === 0}
              title={mode === 'gear' ? 'Take all gear off' : `Take all ${mode} off`}
              onClick={() => (mode === 'gear' ? engine.current?.clearGear() : engine.current?.undress())}
            >
              clear
            </button>
          </div>
        </aside>

        <div className="fw-kit-stage">
          <div className="fw-kit-canvas">
            <Viewer tokens={tokens} onScene={onScene} className="fw-view fw-kit-view" />
            {/* Overlays over the canvas. Their containers let the pointer
                through, so a drag or wheel in any gap still orbits and zooms;
                only the controls themselves take it. */}
            <div className="fw-kit-scene" ref={sceneRef}>
              {!narrow && bodySwitch}
              {!narrow && lightSelect}
              {!narrow && qualitySelect}
              <button
                type="button"
                ref={moreButton}
                className="fw-kit-more-button"
                aria-expanded={moreOpen}
                aria-controls={moreId}
                onClick={() => setMoreOpen((open) => !open)}
              >
                {narrow ? 'Scene' : 'More'}
              </button>
              {/* Rendered closed too, and hidden, so the file inputs it holds
                  stay in the page for their pickers. */}
              <div
                id={moreId}
                className="fw-kit-more"
                role="group"
                aria-label={narrow ? 'Scene' : 'More'}
                hidden={!moreOpen}
              >
                {narrow && (
                  <>
                    <div className="fw-kit-more-row">{bodySwitch}</div>
                    {lightSelect && <div className="fw-kit-more-row">{lightSelect}</div>}
                    {qualitySelect && <div className="fw-kit-more-row">{qualitySelect}</div>}
                  </>
                )}
                {moreRows}
              </div>
            </div>
            <div className="fw-kit-dock">
              <span className="fw-kit-group" role="group" aria-label="Pose">
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
              <span className="fw-kit-group">
                <button
                  type="button"
                  aria-pressed={state?.animated ?? false}
                  disabled={!state || state.pose === 'rest'}
                  title="Play the pose as a loop: the character customizer's idle standing at ease, breathing otherwise"
                  onClick={() => void engine.current?.setAnimated(!(state?.animated ?? false))}
                >
                  animate
                </button>
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
                    {carrying.has(HAND) ? 'put down' : 'nothing'}
                  </button>
                  {holdable.map(([port, item]) => (
                    <button
                      key={port}
                      type="button"
                      role="radio"
                      aria-checked={state?.holding === port}
                      aria-pressed={state?.holding === port}
                      disabled={busy}
                      title={port === HAND
                        ? `The ${displayName(item)}, in the hand: nothing worn holsters it`
                        : `Hold the ${displayName(item)}, from the ${portLabel(state!.ports.get(port)!.port)} holster`}
                      onClick={() => void engine.current?.hold(port)}
                    >
                      {titleOf(item)}
                    </button>
                  ))}
                </span>
              )}
            </div>
          </div>
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
