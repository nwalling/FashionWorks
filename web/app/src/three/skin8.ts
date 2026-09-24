/** Eight bone influences a vertex. RENDERING.md Phase 7.
 *
 * The archive stores eight; three.js skins with four. Keeping the four
 * heaviest and renormalising is what Blender does and what the pipeline has
 * always done, and for most vertices nothing is lost. For the 0.2-4.8 % that
 * use more -- shoulders, elbows, the utility suit's joints -- the dropped tail
 * was 1.7-5.5 % of the weight on average and up to 17 %, which shows as a
 * crease that does not quite follow the bone.
 *
 * A mesh that needs them carries a second pair of attributes, `skinIndex1` and
 * `skinWeight1`, and its materials a `FW_SKIN8` define. The chunks below add
 * the second four bones only under that define, so every other material
 * compiles exactly as before and costs nothing. A piece's shadow is drawn by a
 * depth material that skins the same way, or the shadow would bend four ways
 * while the mesh bends eight.
 *
 * GTAO's normal pass draws with its own override material and so still skins
 * four ways. The difference is a fraction of a degree of normal on a few
 * percent of vertices, under an effect that is itself blurred.
 */

import {
  BufferAttribute,
  type BufferGeometry,
  type Material,
  MeshDepthMaterial,
  type Mesh,
  RGBADepthPacking,
  ShaderChunk,
} from 'three';

const DEFINE = 'FW_SKIN8';

let patched = false;

function patch(name: 'skinning_pars_vertex' | 'skinbase_vertex' | 'skinning_vertex' | 'skinnormal_vertex', at: string, add: string, before = true): void {
  const chunk = ShaderChunk[name];
  if (!chunk.includes(at)) throw new Error(`skin8: ${name} no longer contains its anchor`);
  ShaderChunk[name] = chunk.replace(at, before ? `${add}\n${at}` : `${at}\n${add}`);
}

/** Teach the skinning chunks a second set of four, behind the define. Once. */
export function patchSkinningChunks(): void {
  if (patched) return;
  patched = true;
  patch('skinning_pars_vertex', 'uniform mat4 bindMatrix;', `
	#ifdef ${DEFINE}
		attribute vec4 skinIndex1;
		attribute vec4 skinWeight1;
	#endif`);
  patch('skinbase_vertex', 'mat4 boneMatW = getBoneMatrix( skinIndex.w );', `
	#ifdef ${DEFINE}
		mat4 boneMat1X = getBoneMatrix( skinIndex1.x );
		mat4 boneMat1Y = getBoneMatrix( skinIndex1.y );
		mat4 boneMat1Z = getBoneMatrix( skinIndex1.z );
		mat4 boneMat1W = getBoneMatrix( skinIndex1.w );
	#endif`, false);
  patch('skinning_vertex', 'transformed = ( bindMatrixInverse * skinned ).xyz;', `
	#ifdef ${DEFINE}
		skinned += boneMat1X * skinVertex * skinWeight1.x;
		skinned += boneMat1Y * skinVertex * skinWeight1.y;
		skinned += boneMat1Z * skinVertex * skinWeight1.z;
		skinned += boneMat1W * skinVertex * skinWeight1.w;
	#endif`);
  patch('skinnormal_vertex', 'skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;', `
	#ifdef ${DEFINE}
		skinMatrix += skinWeight1.x * boneMat1X;
		skinMatrix += skinWeight1.y * boneMat1Y;
		skinMatrix += skinWeight1.z * boneMat1Z;
		skinMatrix += skinWeight1.w * boneMat1W;
	#endif`);
}

/** Whether a geometry carries the second set. */
export function hasEight(geometry: BufferGeometry): boolean {
  return geometry.hasAttribute('skinIndex1');
}

/** Give a four-influence geometry an empty second set, for a piece whose
 * materials are shared with one that has eight. Without it the shader reads
 * the attribute's default, (0, 0, 0, 1), and weights every vertex fully to
 * bone 0 on top of its own. */
export function padEight(geometry: BufferGeometry): void {
  if (hasEight(geometry)) return;
  const vertices = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex1', new BufferAttribute(new Uint16Array(vertices * 4), 4));
  geometry.setAttribute('skinWeight1', new BufferAttribute(new Float32Array(vertices * 4), 4));
}

/** Switch a material over to eight influences. Idempotent. */
export function eightWay(material: Material): void {
  const withDefines = material as Material & { defines?: Record<string, unknown> };
  if (withDefines.defines?.[DEFINE] !== undefined) return;
  withDefines.defines = { ...(withDefines.defines ?? {}), [DEFINE]: '' };
  material.needsUpdate = true;
}

let depth: MeshDepthMaterial | null = null;

/** Make a mesh with the second set skin eight ways, shadow included. */
export function skinEight(mesh: Mesh): void {
  patchSkinningChunks();
  for (const material of ([] as Material[]).concat(mesh.material)) eightWay(material);
  // The shadow map's own depth material, as three builds it for a directional
  // light, with the define. Shared: it holds no per-mesh state.
  depth ??= (() => {
    const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    eightWay(material);
    return material;
  })();
  // An alpha-tested surface -- hair cards -- keeps three's own depth
  // material, which cuts the shadow out along the cards; this one would not.
  const tested = ([] as Material[]).concat(mesh.material).some((m) => m.alphaTest > 0);
  if (!tested) mesh.customDepthMaterial = depth;
}
