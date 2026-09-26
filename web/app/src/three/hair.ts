/** Hair cards as geometry: where a strand runs from root to tip, the order a
 * blended pass wants them in, and the mesh that draws that pass.
 *
 * CryEngine draws hair twice (`Hair.cfx`): a cut-out that writes depth, then
 * the rest of each strand blended over it. The blended pass here is a second
 * skinned mesh over the same buffers and the same rig, drawn after every
 * opaque and after the cap, casting no shadow of its own.
 */

import { BufferAttribute, BufferGeometry, type Material, SkinnedMesh, type Vector3 } from 'three';

/** Each card's position from root to tip, 0 to 1, as `fwStrandT`.
 *
 * A hair mesh's vertex colour red is the vertex's step along its card: every
 * card of the beard starts at 0 where it leaves the skin and counts up to its
 * tip, in whole steps of about 2 mm -- ordered exactly as the card's V on all
 * 3,028 cards, its peak tracking the card's length. So the position along a
 * strand is red over the peak of the card it belongs to, a card being the
 * triangles that share vertices. */
export function strandCoordinate(geometry: BufferGeometry, start: number, count: number): boolean {
  const color = geometry.getAttribute('fwColor');
  const index = geometry.getIndex();
  if (!color || !index) return false;
  const vertices = color.count;
  const parent = new Int32Array(vertices);
  for (let i = 0; i < vertices; i += 1) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const used = new Uint8Array(vertices);
  for (let i = start; i < start + count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    join(a, b);
    join(b, c);
    used[a] = used[b] = used[c] = 1;
  }
  const step = (v: number) => Math.round(color.getX(v) * 255);
  const peak = new Float32Array(vertices);
  for (let v = 0; v < vertices; v += 1) {
    if (!used[v]) continue;
    const root = find(v);
    peak[root] = Math.max(peak[root]!, step(v));
  }
  const t = new Float32Array(vertices);
  for (let v = 0; v < vertices; v += 1) {
    const top = used[v] ? peak[find(v)]! : 0;
    t[v] = top > 0 ? step(v) / top : 0;
  }
  geometry.setAttribute('fwStrandT', new BufferAttribute(t, 1));
  return true;
}

/** Put a range's triangles innermost first, by distance from `centre`, so a
 * blended pass lays the outer strands over the inner. A beard is seen from
 * outside, so one order holds from every side and nothing is sorted per
 * frame. */
export function sortInnerFirst(geometry: BufferGeometry, start: number, count: number, centre: Vector3): void {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  if (!index || !position) return;
  const triangles = count / 3;
  const distance = new Float32Array(triangles);
  for (let t = 0; t < triangles; t += 1) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k += 1) {
      const v = index.getX(start + t * 3 + k);
      x += position.getX(v);
      y += position.getY(v);
      z += position.getZ(v);
    }
    distance[t] = Math.hypot(x / 3 - centre.x, y / 3 - centre.y, z / 3 - centre.z);
  }
  const order = Array.from({ length: triangles }, (_, t) => t).sort((a, b) => distance[a]! - distance[b]!);
  const before = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) before[i] = index.getX(start + i);
  for (let t = 0; t < triangles; t += 1) {
    for (let k = 0; k < 3; k += 1) index.setX(start + t * 3 + k, before[order[t]! * 3 + k]!);
  }
  index.needsUpdate = true;
}

/** The blended pass for a skinned hair mesh: the same buffers, drawn with
 * `fringe` over `groups`, after the cap. `null` when no material asks for
 * one. */
export function fringeOf(
  object: SkinnedMesh,
  fringes: Map<number, Material>,
): SkinnedMesh | null {
  if (!fringes.size) return null;
  const source = object.geometry;
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  geometry.setIndex(source.getIndex());
  const materials: Material[] = [];
  for (const group of source.groups) {
    const fringe = fringes.get(group.materialIndex ?? 0);
    if (!fringe) continue;
    geometry.addGroup(group.start, group.count, materials.length);
    materials.push(fringe);
  }
  geometry.boundingBox = source.boundingBox;
  geometry.boundingSphere = source.boundingSphere;
  const mesh = new SkinnedMesh(geometry, materials);
  mesh.name = `${object.name} fringe`;
  mesh.frustumCulled = object.frustumCulled;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // After the cap, which lies on the skin under it.
  mesh.renderOrder = 1;
  mesh.userData.noAo = true;
  return mesh;
}
