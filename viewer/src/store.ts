import { create } from 'zustand';

import type { Item, Manifest, Slot } from './manifest';
import { itemsBySlot, selectableItems } from './manifest';
import type { Loadout, SkeletonName } from './loadout';
import { emptyLoadout, loadoutFromLocation } from './loadout';

const HISTORY_LIMIT = 50;
const STORAGE_KEY = 'sc-kitbasher.loadout';

export interface Filters {
  search: string;
  weightClass: string | null;
  manufacturer: string | null;
  set: string | null;
}

interface State {
  manifest: Manifest | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;

  loadout: Loadout;
  past: Loadout[];
  future: Loadout[];

  filters: Filters;

  setManifest: (manifest: Manifest) => void;
  setError: (message: string) => void;
  setLoading: () => void;

  equip: (slot: Slot, itemId: string | null) => void;
  equipSet: (setKey: string) => void;
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
  };
}

function initialLoadout(): Loadout {
  if (typeof window === 'undefined') return emptyLoadout();
  return loadoutFromLocation(window.location.search) ?? emptyLoadout();
}

export const useStore = create<State>((set, get) => ({
  manifest: null,
  status: 'idle',
  error: null,

  loadout: initialLoadout(),
  past: [],
  future: [],

  filters: { search: '', weightClass: null, manufacturer: null, set: null },

  setManifest: (manifest) => set({ manifest, status: 'ready', error: null }),
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

  equipSet: (setKey) => {
    const state = get();
    const manifest = state.manifest;
    if (!manifest) return;
    const next: Loadout = { ...state.loadout, slots: { ...state.loadout.slots } };
    for (const item of selectableItems(manifest)) {
      if (item.set === setKey) next.slots[item.slot] = item.id;
    }
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
    set(
      withHistory(state, {
        ...state.loadout,
        tints: { ...state.loadout.tints, [materialKey]: color },
      }),
    );
  },

  applyLoadout: (loadout) => {
    const state = get();
    set(withHistory(state, loadout));
  },

  undo: () => {
    const { past, loadout, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({ past: past.slice(0, -1), loadout: previous, future: [loadout, ...future] });
  },

  redo: () => {
    const { past, loadout, future } = get();
    if (future.length === 0) return;
    const [next, ...rest] = future;
    set({ past: [...past, loadout], loadout: next, future: rest });
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
      get().applyLoadout(JSON.parse(raw) as Loadout);
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
