import { BufferAttribute, BufferGeometry, MeshStandardMaterial, ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';

import { eightWay, hasEight, padEight, patchSkinningChunks } from '../src/three/skin8';

describe('eight-influence skinning', () => {
  it('adds the second four to every skinning chunk, behind the define', () => {
    patchSkinningChunks();
    patchSkinningChunks();
    for (const name of ['skinning_pars_vertex', 'skinbase_vertex', 'skinning_vertex', 'skinnormal_vertex'] as const) {
      const chunk = ShaderChunk[name];
      expect(chunk).toContain('#ifdef FW_SKIN8');
      // Once only, however often it is asked for.
      expect(chunk.split('#ifdef FW_SKIN8').length).toBe(2);
    }
    expect(ShaderChunk.skinning_vertex).toContain('boneMat1W * skinVertex * skinWeight1.w');
    expect(ShaderChunk.skinnormal_vertex).toContain('skinWeight1.w * boneMat1W');
  });

  it('pads a four-wide geometry with an empty second set', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    expect(hasEight(geometry)).toBe(false);
    padEight(geometry);
    expect(hasEight(geometry)).toBe(true);
    expect(Array.from(geometry.getAttribute('skinWeight1').array).every((w) => w === 0)).toBe(true);
  });

  it('sets the define once and keeps the material its own', () => {
    const material = new MeshStandardMaterial();
    eightWay(material);
    eightWay(material);
    expect(material.defines).toEqual({ STANDARD: '', FW_SKIN8: '' });
  });
});
