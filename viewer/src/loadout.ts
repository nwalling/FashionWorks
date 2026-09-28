import type { Slot } from './manifest';
import { SLOTS } from './manifest';

export type SkeletonName = 'male' | 'female';

export interface Loadout {
  skeleton: SkeletonName;
  slots: Record<Slot, string | null>;
  tints: Record<string, string>;
}

export function emptyLoadout(skeleton: SkeletonName = 'male'): Loadout {
  return {
    skeleton,
    slots: Object.fromEntries(SLOTS.map((slot) => [slot, null])) as Record<Slot, string | null>,
    tints: {},
  };
}

export function equippedIds(loadout: Loadout): string[] {
  return SLOTS.map((slot) => loadout.slots[slot]).filter((id): id is string => id !== null);
}

// --- share URLs -----------------------------------------------------------
// A loadout round-trips through ?l=<base64url(JSON)>, so the deployed viewer
// needs no backend to share a build (PLAN.md §5.5).

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeLoadout(loadout: Loadout): string {
  const compact = {
    s: loadout.skeleton,
    e: Object.fromEntries(
      SLOTS.map((slot) => [slot, loadout.slots[slot]]).filter(([, id]) => id !== null),
    ),
    t: loadout.tints,
  };
  return toBase64Url(JSON.stringify(compact));
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/** A loadout from outside -- a share link or localStorage -- checked field by
 * field. Anything that is not a slot id or a `#rrggbb` tint is dropped rather
 * than handed to three.js, where a non-string colour throws during render. */
export function sanitizeLoadout(value: unknown): Loadout {
  const raw = (value && typeof value === 'object' ? value : {}) as {
    s?: unknown;
    e?: unknown;
    t?: unknown;
  };
  const loadout = emptyLoadout(raw.s === 'female' ? 'female' : 'male');
  const slots = raw.e && typeof raw.e === 'object' ? (raw.e as Record<string, unknown>) : {};
  for (const slot of SLOTS) {
    const id = slots[slot];
    if (typeof id === 'string') loadout.slots[slot] = id;
  }
  const tints = raw.t && typeof raw.t === 'object' && !Array.isArray(raw.t) ? raw.t : {};
  loadout.tints = Object.fromEntries(
    Object.entries(tints).filter(([, colour]) => typeof colour === 'string' && HEX_COLOUR.test(colour)),
  ) as Record<string, string>;
  return loadout;
}

export function decodeLoadout(encoded: string): Loadout | null {
  try {
    return sanitizeLoadout(JSON.parse(fromBase64Url(encoded)));
  } catch (error) {
    console.warn('[loadout] could not decode share link', error);
    return null;
  }
}

export function loadoutFromLocation(search: string): Loadout | null {
  const encoded = new URLSearchParams(search).get('l');
  return encoded ? decodeLoadout(encoded) : null;
}

export function shareUrl(loadout: Loadout, href: string): string {
  const url = new URL(href);
  url.searchParams.set('l', encodeLoadout(loadout));
  return url.toString();
}
