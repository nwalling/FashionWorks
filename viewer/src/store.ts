import { create } from 'zustand';

import type { Item, Manifest, Slot } from './manifest';
import { itemsBySlot, selectableItems } from './manifest';
import type { Loadout, SkeletonName } from './loadout';
import type { PoseLibrary } from './three/poses';
import { emptyLoadout, loadoutFromLocation, sanitizeLoadout } from './loadout';

const HISTORY_LIMIT = 50;
/**
 * Gap that ends a run of coalesced tint edits. A colour picker drag emits
 * changes milliseconds apart, so anything slower is a fresh gesture.
 */
const TINT_COALESCE_MS = 600;
const STORAGE_KEY = 'sc-kitbasher.loadout';

export interface Filters {
  search: string;
  weightClass: string | null;
  manufacturer: string | null;
  set: string | null;
}

interface State {
  manifest: Manifest | null;
  poses: PoseLibrary;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;

  loadout: Loadout;
  past: Loadout[];
  future: Loadout[];
  /**
   * Key of the edit currently being coalesced into one undo step, or null.
   * A colour picker fires `onChange` continuously while dragged, and pushing
   * every one produced 40 history entries for a single gesture — enough to
   * blow the whole 50-entry stack away and demand 40 undos to reverse it.
   */
  coalescing: string | null;
  /** When the current coalescing run last advanced, for the gesture window. */
  coalescedAt: number;

  filters: Filters;

  setManifest: (manifest: Manifest) => void;
  setPoses: (poses: PoseLibrary) => void;
  setError: (message: string) => void;
  setLoading: () => void;

  equip: (slot: Slot, itemId: string | null) => void;
  equipSet: (setKey: string, anchorId?: string) => void;
  clear: () => void;
  randomize: () => void;
  setSkeleton: (skeleton: SkeletonName) => void;
  setTint: (materialKey: string, color: string) => void;
  applyLoadout: (loadout: Loadout) => void;

  undo: () => void;
  redo: () => void;
  save: () => void;
  restore: () => void;

  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;

  visibleItems: (slot: Slot) => Item[];
}

function withHistory(state: State, next: Loadout): Partial<State> {
  return {
    past: [...state.past, state.loadout].slice(-HISTORY_LIMIT),
    loadout: next,
    future: [],
    // Any other action ends a run of coalescable edits.
    coalescing: null,
    coalescedAt: 0,
  };
}

function initialLoadout(): Loadout {
  if (typeof window === 'undefined') return emptyLoadout();
  return loadoutFromLocation(window.location.search) ?? emptyLoadout();
}

export const useStore = create<State>((set, get) => ({
  manifest: null,
  poses: {},
  status: 'idle',
  error: null,

  loadout: initialLoadout(),
  past: [],
  future: [],
  coalescing: null,
  coalescedAt: 0,

  filters: { search: '', weightClass: null, manufacturer: null, set: null },

  setManifest: (manifest) => set({ manifest, status: 'ready', error: null }),
  setPoses: (poses) => set({ poses }),
  setError: (message) => set({ status: 'error', error: message }),
  setLoading: () => set({ status: 'loading', error: null }),

  equip: (slot, itemId) => {
    const state = get();
    const next: Loadout = {
      ...state.loadout,
      slots: { ...state.loadout.slots, [slot]: itemId },
    };
    set(withHistory(state, next));
  },

  equipSet: (setKey, anchorId) => {
    const state = get();
    const manifest = state.manifest;
    if (!manifest) return;

    // A set key can cover several distinct product families: the game tags
    // "cds_heavy_set01" onto ADP, ADP-mk4, DCP, Defiance, Balor and more. Just
    // equipping everything with that key meant the last item written to each
    // slot won, so every set produced the same outfit. Anchor on the item the
    // user clicked and prefer its family and, importantly, its colour.
    //
    // Colour variants are candidates here rather than being skipped: picking
    // the matching colour per slot is the whole point of equipping a set from
    // a chosen swatch.
    const all = selectableItems(manifest).filter((item) => item.set === setKey);
    const anchor = anchorId ? all.find((item) => item.id === anchorId) : undefined;

    const family = (item: Item) => item.name.split(/[\s(]/)[0].toLowerCase();
    const palette = (item: Item) => JSON.stringify(item.tint?.colors ?? null);
    // Everything after the slot word: "(Modified)", "Tactical", "Red Alert".
    // This is what separates two colourways of the same product line, and the
    // game does not always give them a shared palette.
    const edition = (item: Item) =>
      item.name.split(/[\s(]/).slice(2).join(' ').replace(/\)/g, '').trim().toLowerCase();

    // Product line first, then edition, then palette. Palette used to outrank
    // family, which let a different product line win a slot whenever it
    // happened to share a colour: equipping from Defiance Core (Modified) put
    // ADP Arms (Modified) on the arms. Palette cannot be the primary key
    // anyway, because pieces of one edition do not reliably share one -- the
    // Defiance Modified helmet and arms carry a different palette from its
    // core and legs.
    const score = (item: Item): number => {
      if (!anchor) return item.variant_of === null ? 1 : 0;
      let value = 0;
      if (family(item) === family(anchor)) value += 8;
      if (edition(item) === edition(anchor)) value += 4;
      if (palette(item) === palette(anchor)) value += 2;
      // Break ties towards the canonical item so a set without colour data
      // still lands on one obvious choice.
      if (item.variant_of === null) value += 1;
      return value;
    };

    const next: Loadout = { ...state.loadout, slots: { ...state.loadout.slots } };
    const best = new Map<Slot, { item: Item; score: number }>();
    for (const item of all) {
      const current = best.get(item.slot);
      const value = score(item);
      if (!current || value > current.score) best.set(item.slot, { item, score: value });
    }
    for (const [slot, { item }] of best) next.slots[slot] = item.id;
    if (anchor) next.slots[anchor.slot] = anchor.id;

    set(withHistory(state, next));
  },

  clear: () => {
    const state = get();
    set(withHistory(state, emptyLoadout(state.loadout.skeleton)));
  },

  randomize: () => {
    const state = get();
    const manifest = state.manifest;
    if (!manifest) return;
    const grouped = itemsBySlot(selectableItems(manifest));
    const next: Loadout = { ...state.loadout, slots: { ...state.loadout.slots } };
    for (const [slot, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      next.slots[slot as Slot] = items[Math.floor(Math.random() * items.length)].id;
    }
    set(withHistory(state, next));
  },

  setSkeleton: (skeleton) => {
    const state = get();
    set(withHistory(state, { ...state.loadout, skeleton }));
  },

  setTint: (materialKey, color) => {
    const state = get();
    const next: Loadout = {
      ...state.loadout,
      tints: { ...state.loadout.tints, [materialKey]: color },
    };

    // One drag of the picker is one edit. While the run continues the head of
    // the history stays put and only the live loadout moves, so undo returns
    // to the colour the piece had before the drag started rather than stepping
    // back through every intermediate shade.
    //
    // The store never sees a pointerup, so the gesture boundary is inferred
    // from the gap between events: a drag emits them milliseconds apart, while
    // coming back to the same swatch later is a new edit. Without the window,
    // every drag of one swatch for the rest of the session folded into a single
    // undo step.
    const key = `tint:${materialKey}`;
    const now = Date.now();
    if (state.coalescing === key && now - state.coalescedAt < TINT_COALESCE_MS) {
      set({ loadout: next, future: [], coalescedAt: now });
      return;
    }

    set({ ...withHistory(state, next), coalescing: key, coalescedAt: now });
  },

  applyLoadout: (loadout) => {
    const state = get();
    set(withHistory(state, loadout));
  },

  undo: () => {
    const { past, loadout, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({ past: past.slice(0, -1), loadout: previous, future: [loadout, ...future], coalescing: null, coalescedAt: 0 });
  },

  redo: () => {
    const { past, loadout, future } = get();
    if (future.length === 0) return;
    const [next, ...rest] = future;
    set({ past: [...past, loadout], loadout: next, future: rest, coalescing: null, coalescedAt: 0 });
  },

  save: () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(get().loadout));
    } catch (error) {
      console.warn('[store] could not save loadout', error);
    }
  },

  restore: () => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as { skeleton?: unknown; slots?: unknown; tints?: unknown } | null;
      get().applyLoadout(sanitizeLoadout({ s: stored?.skeleton, e: stored?.slots, t: stored?.tints }));
    } catch (error) {
      console.warn('[store] could not restore loadout', error);
    }
  },

  setFilter: (key, value) => set((state) => ({ filters: { ...state.filters, [key]: value } })),

  visibleItems: (slot) => {
    const { manifest, filters } = get();
    if (!manifest) return [];
    const search = filters.search.trim().toLowerCase();
    return selectableItems(manifest).filter((item) => {
      if (item.slot !== slot) return false;
      if (item.variant_of !== null) return false;
      if (filters.weightClass && item.weight_class !== filters.weightClass) return false;
      if (filters.manufacturer && item.manufacturer.code !== filters.manufacturer) return false;
      if (filters.set && item.set !== filters.set) return false;
      if (search && !`${item.name} ${item.class_name}`.toLowerCase().includes(search)) return false;
      return true;
    });
  },
}));

if (import.meta.env.DEV) {
  // Dev-only handle: lets the swap-leak check in PLAN.md §7 drive the store
  // from the console instead of scripting 50 UI clicks.
  (window as unknown as Record<string, unknown>).__store = useStore;
}
