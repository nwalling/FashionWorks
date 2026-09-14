import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';

/**
 * A byte budget over the `useGLTF` suspense cache.
 *
 * drei caches every loaded GLB by URL and never releases one. That is what
 * makes a repeat swap instant, and measured on real assets repeat swaps really
 * are free: cycling 36 times through 12 already-seen helmets held the renderer
 * flat at 25 geometries and 44 textures. The cost is paid on *first* sight of
 * an item, and it is never refunded — 12 distinct helmets took the heap from
 * 56 MB to 220 MB, a steady 13.6 MB each, with only two meshes ever in the
 * scene.
 *
 * The catalog has 471 distinct GLBs. At that rate browsing all of them wants
 * ~6.4 GB against a 4.19 GB tab limit, so the tab dies around 300 items, about
 * two thirds of the way through. This module keeps the cheap repeat swap and
 * puts a ceiling on the growth: least-recently-used GLBs are disposed once the
 * retained total exceeds the budget.
 *
 * Anything currently equipped is pinned and never evicted. That is what makes
 * disposal safe at all: `ArmorPiece` reparents cloned meshes into the base
 * character, and those clones share geometry, materials and textures with the
 * cached original, so a piece on screen still owns the cache entry it came
 * from.
 */

/**
 * How much decoded GLB to keep. 768 MB is roughly 56 items at the measured
 * 13.6 MB, which is far more than a browsing session revisits, while leaving
 * the tab a wide margin under its heap limit.
 */
const DEFAULT_BUDGET_BYTES = 768 * 1024 * 1024;

let budgetBytes = DEFAULT_BUDGET_BYTES;

interface Entry {
  url: string;
  root: THREE.Object3D;
  bytes: number;
  /** Monotonic counter rather than a clock, so ties cannot happen. */
  lastUsed: number;
  /** Mounted `ArmorPiece`s holding this GLB. Pinned entries never evict. */
  pins: number;
}

const entries = new Map<string, Entry>();
let clock = 0;
let totalBytes = 0;

function geometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name] as THREE.BufferAttribute;
    bytes += attribute.array?.byteLength ?? 0;
  }
  bytes += geometry.index?.array.byteLength ?? 0;
  return bytes;
}

function textureBytes(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!width || !height) return 0;
  // Uploaded as RGBA8; a full mip chain adds a third again.
  return Math.round(width * height * 4 * (texture.generateMipmaps === false ? 1 : 4 / 3));
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  if (!mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function texturesOf(material: THREE.Material): THREE.Texture[] {
  const found: THREE.Texture[] = [];
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value && (value as THREE.Texture).isTexture) found.push(value as THREE.Texture);
  }
  return found;
}

/** Every distinct geometry, material and texture hanging off a loaded scene. */
function collect(root: THREE.Object3D): {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
} {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of materialsOf(mesh)) {
      materials.add(material);
      for (const texture of texturesOf(material)) textures.add(texture);
    }
  });

  return { geometries, materials, textures };
}

/**
 * Retained size of a loaded GLB. Measured from the decoded buffers rather than
 * the file size, because that is what actually stays resident: the decoded
 * footprint ran about 1.8x the 7.3 MB average file.
 */
export function measure(root: THREE.Object3D): number {
  const { geometries, textures } = collect(root);
  let bytes = 0;
  for (const geometry of geometries) bytes += geometryBytes(geometry);
  for (const texture of textures) bytes += textureBytes(texture);
  return bytes;
}

function dispose(entry: Entry): void {
  const { geometries, materials, textures } = collect(entry.root);
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();

  // Drop the suspense entry too, or the next mount resolves the disposed
  // objects straight back out of the cache.
  try {
    useGLTF.clear(entry.url);
  } catch (error) {
    console.warn('[gltfCache] useGLTF.clear failed', entry.url, error);
  }
  // GLTFLoader parks the raw buffer here when THREE.Cache is on.
  THREE.Cache.remove(entry.url);
}

/** Evict least-recently-used unpinned entries until back inside the budget. */
function evict(): void {
  if (totalBytes <= budgetBytes) return;

  const candidates = [...entries.values()]
    .filter((entry) => entry.pins === 0)
    .sort((a, b) => a.lastUsed - b.lastUsed);

  for (const entry of candidates) {
    if (totalBytes <= budgetBytes) break;
    dispose(entry);
    entries.delete(entry.url);
    totalBytes -= entry.bytes;
  }
}

/**
 * Register a mounted GLB and hold it against eviction. Returns the release
 * function; call it once the piece's meshes are out of the scene.
 */
export function retain(url: string, root: THREE.Object3D): () => void {
  let entry = entries.get(url);
  if (!entry) {
    entry = { url, root, bytes: measure(root), lastUsed: 0, pins: 0 };
    entries.set(url, entry);
    totalBytes += entry.bytes;
  } else if (entry.root !== root) {
    // Re-resolved after an eviction: the old objects are gone, re-measure.
    totalBytes -= entry.bytes;
    entry.root = root;
    entry.bytes = measure(root);
    totalBytes += entry.bytes;
  }

  entry.pins += 1;
  clock += 1;
  entry.lastUsed = clock;
  evict();

  let released = false;
  return () => {
    // Effects can be torn down twice in development; only the first counts.
    if (released) return;
    released = true;
    const current = entries.get(url);
    if (!current) return;
    current.pins = Math.max(0, current.pins - 1);
    clock += 1;
    current.lastUsed = clock;
    evict();
  };
}

export function stats(): {
  entries: number;
  pinned: number;
  totalMB: number;
  budgetMB: number;
} {
  return {
    entries: entries.size,
    pinned: [...entries.values()].filter((entry) => entry.pins > 0).length,
    totalMB: +(totalBytes / 1048576).toFixed(1),
    budgetMB: +(budgetBytes / 1048576).toFixed(1),
  };
}

/** Set the budget in bytes. Lowering it evicts immediately. */
export function setBudget(bytes: number): void {
  budgetBytes = Math.max(0, bytes);
  evict();
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__gltfCache = { stats, setBudget, measure };
}
