/** The floor: where the key light's shadow lands.
 *
 * Not a blob. The shadow is the key light's own shadow map, cast by every
 * piece on the body and everything carried, so it has the character's shape,
 * falls the way the armour is lit, and moves with the pose.
 *
 * The floor itself is only a colour over whatever is behind it -- the theme's
 * page colour or a backdrop photograph -- so what it adds depends on which:
 *
 * - **dark theme**: a shadow on a near-black page is invisible, so the lit
 *   floor is lifted slightly toward the text colour, a pool the shadow is cut
 *   out of, and the shadow darkens what is left;
 * - **light theme**: the page is already the lit floor, so only the shadow
 *   draws;
 * - **backdrop**: only the shadow, a little stronger, over the photograph.
 *
 * **The penumbra widens with distance from what casts it**, as it does under
 * any light bigger than a point: sharp where a boot meets the floor, soft
 * where the helmet's shadow lands a couple of metres away. The engine's own
 * PCF filters every texel by the same few-millimetre kernel, which read as a
 * hard black cut-out against armour lit this softly. So the floor filters the
 * key light's shadow map itself: a blocker search finds how far above the
 * floor the occluder is, and the kernel is sized from that (PCSS). The armour
 * keeps the engine's filter for its own self-shadowing, where occluders are
 * centimetres away and a sharp edge is right.
 *
 * Both fade out radially so the floor never shows an edge. It sits at y=0 with
 * the grid and is pulled toward the camera by a polygon offset, so it wins
 * the depth test against the grid lines and the shadow darkens them too --
 * below the grid, the lines would draw over the shadow as if lit.
 */

import { Color, Mesh, PlaneGeometry, ShadowMaterial } from 'three';

import { toHex, type Tokens } from '../theme';

export interface GroundLook {
  /** What the lit floor adds over the background, and how much. */
  readonly lit: number;
  readonly litAlpha: number;
  /** What a shadowed texel adds, and how much. */
  readonly shadow: number;
  readonly shadowAlpha: number;
}

/** Radius, in metres, at which the floor starts to fade and where it is gone.
 * The grid spans two metres either side; a standing figure's shadow reaches
 * about 1.8 m from the feet under the key light. */
const FADE_INNER = 0.9;
const FADE_OUTER = 3.0;

/** Penumbra width per metre between occluder and floor: the key light as a
 * source about three degrees across, a softbox rather than the sun. A boot's
 * shadow stays crisp; the head's, 2.5 m away along the light, spreads over
 * about 12 cm, which keeps the torso's shape readable. */
export const PENUMBRA_PER_METRE = 0.05;
/** The widest penumbra searched for, in metres. */
const SEARCH = 0.14;

/** How the floor reads against a theme, or over a backdrop. */
export function groundLook(tokens: Tokens, light: boolean, backdrop: boolean): GroundLook {
  if (backdrop) return { lit: 0, litAlpha: 0, shadow: 0, shadowAlpha: SHADOW_DEPTH };
  if (light) return { lit: 0, litAlpha: 0, shadow: 0, shadowAlpha: SHADOW_DEPTH * 0.8 };
  return { lit: toHex(tokens['--sc-text']), litAlpha: 0.07, shadow: 0, shadowAlpha: SHADOW_DEPTH };
}

/** How much a full shadow takes off the floor, from the lights themselves:
 * the key is 2.2 at 45 degrees to the floor, against 1.3 ambient and a 0.6 rim
 * at 25 degrees, so blocking the key leaves (1.3 + 0.26) / (1.3 + 0.26 + 1.56)
 * of the light -- half. */
const SHADOW_DEPTH = 0.5;

export interface ShadowFrame {
  /** Half the shadow camera's width, metres. */
  readonly reach: number;
  /** The shadow camera's far minus near, metres: depth 0-1 to distance. */
  readonly depth: number;
}

export interface Ground {
  readonly mesh: Mesh;
  setLook(look: GroundLook): void;
  dispose(): void;
}

/** PCSS against the first directional shadow map, which is the key light's.
 *
 * Both searches use a golden-angle spiral rotated per pixel by interleaved
 * gradient noise, so 24 and 48 taps read as a smooth gradient rather than as
 * rings; at 16 and 32 the grain showed. The shadow camera is orthographic, so depth is linear and a depth
 * difference times its range is metres along the light. */
const SOFT_SHADOW = `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
vec2 spiral( int i, int count, float turn ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( count ) );
  float a = float( i ) * 2.39996323 + turn;
  return r * vec2( cos( a ), sin( a ) );
}
float softShadow() {
  vec3 c = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
  c.z += directionalLightShadows[ 0 ].shadowBias;
  if ( any( lessThan( c, vec3( 0.0 ) ) ) || any( greaterThan( c, vec3( 1.0 ) ) ) ) return 1.0;
  float turn = 6.28318531 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float search = ${SEARCH.toFixed(3)} * uToUv;
  float blockers = 0.0;
  float found = 0.0;
  for ( int i = 0; i < 24; i ++ ) {
    float d = unpackRGBAToDepth( texture2D( directionalShadowMap[ 0 ], c.xy + spiral( i, 24, turn ) * search ) );
    if ( d < c.z ) { blockers += d; found += 1.0; }
  }
  if ( found == 0.0 ) return 1.0;
  float height = ( c.z - blockers / found ) * uDepthRange;
  float texel = 1.0 / directionalLightShadows[ 0 ].shadowMapSize.x;
  float radius = max( height * ${PENUMBRA_PER_METRE.toFixed(3)} * uToUv, 1.5 * texel );
  float lit = 0.0;
  for ( int i = 0; i < 48; i ++ ) {
    lit += step( c.z, unpackRGBAToDepth( texture2D( directionalShadowMap[ 0 ], c.xy + spiral( i, 48, turn ) * radius ) ) );
  }
  return lit / 48.0;
}
#else
float softShadow() { return 1.0; }
#endif
`;

export function createGround(frame: ShadowFrame): Ground {
  const uniforms = {
    uLit: { value: new Color() },
    uLitAlpha: { value: 0 },
    uShadow: { value: new Color() },
    uShadowAlpha: { value: 0.5 },
    uFade: { value: [FADE_INNER, FADE_OUTER] as [number, number] },
    // Metres to shadow-map UV, and depth to metres.
    uToUv: { value: 1 / (2 * frame.reach) },
    uDepthRange: { value: frame.depth },
  };
  const material = new ShadowMaterial({
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFloor;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFloor = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec2 vFloor;',
        'uniform vec3 uLit;',
        'uniform float uLitAlpha;',
        'uniform vec3 uShadow;',
        'uniform float uShadowAlpha;',
        'uniform vec2 uFade;',
        'uniform float uToUv;',
        'uniform float uDepthRange;',
      ].join('\n'))
      // After the engine's shadow declarations, which it reads.
      .replace('#include <shadowmask_pars_fragment>', `#include <shadowmask_pars_fragment>\n${SOFT_SHADOW}`)
      .replace(
        'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
        [
          'float lit = softShadow();',
          'float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(vFloor));',
          // Blended premultiplied: mixing colour and alpha separately put a
          // half-lit texel at half the text colour and a third opacity, which
          // drew every penumbra as a pale halo brighter than the lit floor.
          'float alpha = mix(uShadowAlpha, uLitAlpha, lit);',
          'vec3 premultiplied = mix(uShadow * uShadowAlpha, uLit * uLitAlpha, lit);',
          'gl_FragColor = vec4(premultiplied / max(alpha, 1e-4), alpha * fade);',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'fw-ground';

  const geometry = new PlaneGeometry(FADE_OUTER * 2, FADE_OUTER * 2);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'fw-ground';
  mesh.receiveShadow = true;
  // Before the armour's own transparent pieces -- visors -- which sit above it.
  mesh.renderOrder = -1;

  return {
    mesh,
    setLook(look) {
      uniforms.uLit.value.setHex(look.lit);
      uniforms.uLitAlpha.value = look.litAlpha;
      uniforms.uShadow.value.setHex(look.shadow);
      uniforms.uShadowAlpha.value = look.shadowAlpha;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
