/** Hair cards as geometry: where a strand runs from root to tip, the order a
 * blended pass wants them in, and the mesh that draws that pass.
 *
 * CryEngine draws hair twice (`Hair.cfx`): a cut-out that writes depth, then
 * the rest of each strand blended over it. The blended pass here is a second
 * skinned mesh over the same buffers and the same rig, drawn after every
 * opaque and after the cap, casting no shadow of its own.
 */

import { BufferAttribute, BufferGeometry, type Material, SkinnedMesh, type Vector3 } from 'three';

/** Each card's position from root to tip, 0 to 1, as `fwStrandT`, and its
 * distance out from the root as the vertex red itself, 0 to 1, as
 * `fwStrandD`.
 *
 * A hair mesh's vertex colour red is the vertex's step along its card: every
 * card of the beard starts at 0 where it leaves the skin and counts up to its
 * tip, in whole steps of about 2 mm -- ordered exactly as the card's V on all
 * 3,028 cards, its peak tracking the card's length. `hair_75` holds it on all
 * 4,464 cards and `brows_002` on 99%; lashes carry 0 throughout. So the position along a
 * strand is red over the peak of the card it belongs to, a card being the
 * triangles that share vertices. Walking each card's rows of equal red from
 * the root gives 468 steps a metre on the beard, 461 on the brows and 495 on
 * `hair_75` (`examples/strand_units.rs`): a step is about 2.1 mm, and the red
 * as a shader reads it, 0 to 1, runs about 0.54 m. That is the unit the dye's
 * gradient is set in (`dyeAt`). */
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
  // A card that never counts -- lashes carry 0 throughout -- has no root or
  // tip to speak of, and sits mid-strand: neither shaded as a root nor faded
  // as a tip. A mesh with no counting card at all gets no coordinate.
  let counts = false;
  const t = new Float32Array(vertices);
  const d = new Float32Array(vertices);
  for (let v = 0; v < vertices; v += 1) {
    const top = used[v] ? peak[find(v)]! : 0;
    if (top > 0) counts = true;
    t[v] = top > 0 ? step(v) / top : 0.5;
    d[v] = color.getX(v);
  }
  if (!counts) return false;
  geometry.setAttribute('fwStrandT', new BufferAttribute(t, 1));
  geometry.setAttribute('fwStrandD', new BufferAttribute(d, 1));
  return true;
}

/** Give hair cards their real frame: the strand as the tangent, the card's
 * normal from its triangles. True when the mesh needed it.
 *
 * **A hair mesh's normal stream is the strand, not the card's normal.** On
 * `hair_75`, the beard and the brows the vertex "normal" lies along the card
 * from root to tip (|n . root->tip| median 0.97, 0.96, 0.95), perpendicular
 * to the tangent, and at a median 0.12 to the triangle's own normal -- which
 * is the cross product of the two (`examples/hair_frame.rs`). CryEngine's
 * `Hair.cfx` never reads a normal: it builds one as tangent x bitangent and
 * takes the hair's direction from the bitangent. Bound as three.js's normal,
 * every card was lit with its normal pointing along the strand.
 *
 * Decided by the data, card groups only: where the stream sits at less than
 * half the triangles' normal on average it is the strand, and it moves to
 * `tangent` (w 1, skinned with the mesh) while the normals are rebuilt from
 * the triangles. A mesh whose stream is a real normal is left alone. */
export function strandFrame(geometry: BufferGeometry, ranges: ReadonlyArray<{ start: number; count: number }>): boolean {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!index || !position || !normal || !ranges.length) return false;
  let sum = 0;
  let n = 0;
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (const { start, count } of ranges) {
    for (let i = start; i < start + count; i += 3) {
      const v0 = index.getX(i);
      const v1 = index.getX(i + 1);
      const v2 = index.getX(i + 2);
      for (let k = 0; k < 3; k += 1) {
        a[k] = position.getComponent(v1, k) - position.getComponent(v0, k);
        b[k] = position.getComponent(v2, k) - position.getComponent(v0, k);
      }
      const fx = a[1]! * b[2]! - a[2]! * b[1]!;
      const fy = a[2]! * b[0]! - a[0]! * b[2]!;
      const fz = a[0]! * b[1]! - a[1]! * b[0]!;
      const fl = Math.hypot(fx, fy, fz);
      if (fl < 1e-12) continue;
      for (const v of [v0, v1, v2]) {
        const nx = normal.getX(v);
        const ny = normal.getY(v);
        const nz = normal.getZ(v);
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-6) continue;
        sum += Math.abs(fx * nx + fy * ny + fz * nz) / (fl * nl);
        n += 1;
      }
    }
  }
  if (!n || sum / n >= 0.5) return false;
  const vertices = normal.count;
  const tangent = new Float32Array(vertices * 4);
  for (let v = 0; v < vertices; v += 1) {
    const x = normal.getX(v);
    const y = normal.getY(v);
    const z = normal.getZ(v);
    const l = Math.hypot(x, y, z) || 1;
    tangent[v * 4] = x / l;
    tangent[v * 4 + 1] = y / l;
    tangent[v * 4 + 2] = z / l;
    tangent[v * 4 + 3] = 1;
  }
  geometry.setAttribute('tangent', new BufferAttribute(tangent, 4));
  geometry.deleteAttribute('normal');
  geometry.computeVertexNormals();
  // A vertex no triangle reaches, or one whose triangles cancel, keeps a
  // normal across its strand rather than none.
  const rebuilt = geometry.getAttribute('normal');
  for (let v = 0; v < vertices; v += 1) {
    if (Math.hypot(rebuilt.getX(v), rebuilt.getY(v), rebuilt.getZ(v)) > 0.5) continue;
    const tx = tangent[v * 4]!;
    const ty = tangent[v * 4 + 1]!;
    const tz = tangent[v * 4 + 2]!;
    // Any unit vector perpendicular to the strand.
    const px = Math.abs(ty) < 0.9 ? -tz : 0;
    const py = Math.abs(ty) < 0.9 ? 0 : tz;
    const pz = Math.abs(ty) < 0.9 ? tx : -ty;
    const pl = Math.hypot(px, py, pz) || 1;
    rebuilt.setXYZ(v, px / pl, py / pl, pz / pl);
  }
  rebuilt.needsUpdate = true;
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
  mesh.userData.hairFringe = true;
  return mesh;
}
