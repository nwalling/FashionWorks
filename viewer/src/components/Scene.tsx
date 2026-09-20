import { Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  Grid,
  OrbitControls,
  PerspectiveCamera,
} from '@react-three/drei';
import * as THREE from 'three';

import { useStore } from '../store';
import { SLOTS } from '../manifest';
import { ArmorPiece } from './ArmorPiece';
import { Backdrop, backdropSrc, type BackdropChoice } from './Backdrop';
import { REST_POSE, type Pose } from '../three/poses';
import { BaseCharacter } from './BaseCharacter';

export const HDR_PRESETS = ['warehouse', 'city', 'sunset'] as const;
export type HdrPreset = (typeof HDR_PRESETS)[number];

/** Exposes the renderer to the export/screenshot helpers. */
function CaptureBridge({ onReady }: { onReady: (state: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera }) => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    onReady({ gl, scene, camera });
    if (import.meta.env.DEV) {
      // Dev-only handle for inspecting binding and renderer memory from the
      // console, which is how the swap-leak check in PLAN.md §7 is measured.
      (window as unknown as Record<string, unknown>).__kitbasher = { gl, scene, camera };
    }
  }, [gl, scene, camera, onReady]);
  return null;
}

/**
 * Lighting matched to how the game actually renders this armour.
 *
 * Measured against an in-game capture of Defiance Tactical with an Artimex
 * helmet: over the torso the game reads mean 34, median 29, 95th percentile
 * 68 -- dark and, more to the point, flat. The scene used to stack a full
 * image-based light at full strength with a 1.1 directional and a 0.25
 * ambient, giving mean 67, median 52 and a 95th percentile of 157. Armour
 * looked chrome partly because of that.
 *
 * Mean and median now land within a point of the reference. The knob that
 * did it was ambient, not exposure: dropping exposure matches the highlights
 * but crushes the midtones, because the problem was the *width* of the range,
 * not its level. Ambient fill lifts the darks without adding highlights and
 * compresses it, which is what reads as matte.
 *
 * The 95th percentile still sits near 89 against the reference's 68. That
 * residual is specular response, so no lighting value fixes it -- it wants
 * lower metalness or higher roughness in the bake, which is a material
 * question and is recorded in CLAUDE.md rather than papered over here.
 */
const ENV_INTENSITY = 0.25;
const EXPOSURE = 0.85;

export function Scene({
  preset,
  backdrop,
  customBackdrop,
  pose,
  onReady,
}: {
  preset: HdrPreset;
  backdrop: BackdropChoice;
  customBackdrop: string | null;
  pose: string;
  onReady: (state: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera }) => void;
}) {
  const manifest = useStore((state) => state.manifest);
  const loadout = useStore((state) => state.loadout);
  const poses = useStore((state) => state.poses);
  const activePose: Pose | null = pose === REST_POSE ? null : poses[pose] ?? null;

  const skeletonEntry = manifest?.skeletons[loadout.skeleton] ?? Object.values(manifest?.skeletons ?? {})[0];
  const baseGlb = skeletonEntry?.glb ?? null;
  const byId = new Map((manifest?.items ?? []).map((item) => [item.id, item]));

  // A rigid piece mounts where the worn torso says, not where the bare rig
  // does. The torso is the piece whose bulk the mount has to clear; the
  // undersuit is a fallback for when no torso is equipped.
  const torsoId = loadout.slots.torso ?? loadout.slots.undersuit;
  const mountOffsets = (torsoId ? byId.get(torsoId)?.socket_offsets : undefined) ?? {};

  // A user-opened image is an object URL and is already absolute; a built-in
  // one is a path under the served asset root.
  const plate = backdropSrc(backdrop, customBackdrop);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = EXPOSURE;
      }}
    >
      <CaptureBridge onReady={onReady} />
      <PerspectiveCamera makeDefault position={[0, 1.25, 3.1]} fov={38} />
      <OrbitControls target={[0, 1.05, 0]} enableDamping minDistance={1.1} maxDistance={7} />
      <color attach="background" args={['#0d0f12']} />

      <Suspense fallback={null}>
        <Environment preset={preset} environmentIntensity={ENV_INTENSITY} />
        {plate ? <Backdrop src={plate} /> : null}
        {baseGlb ? (
          <BaseCharacter glb={baseGlb} pose={activePose}>
            {SLOTS.map((slot) => {
              const id = loadout.slots[slot];
              const item = id ? byId.get(id) : undefined;
              if (!item || !item.assets.glb) return null;
              // A variant reuses the canonical mesh but carries its own
              // composited textures, which ArmorPiece swaps in. Multiplying a
              // flat palette colour over the albedo, as this used to, repainted
              // the whole piece including the parts the artist never tinted.
              // Only an explicit user choice is a flat tint now.
              const tint = loadout.tints[item.id];
              const offset = item.socket ? mountOffsets[item.socket] : undefined;
              return (
                <ArmorPiece
                  key={item.id}
                  item={item}
                  tint={tint}
                  socketOffset={
                    offset && offset.length === 3
                      ? [offset[0], offset[1], offset[2]]
                      : undefined
                  }
                />
              );
            })}
          </BaseCharacter>
        ) : null}
      </Suspense>

      {/* The reference grid reads as floating debris once there is a photo
          behind the character, so it only shows on the plain background. */}
      {plate ? null : (
        <Grid
          args={[12, 12]}
          cellColor="#1d2228"
          sectionColor="#2b333c"
          infiniteGrid
          fadeDistance={16}
          position={[0, 0, 0]}
        />
      )}
      <directionalLight position={[3, 5, 2]} intensity={0.15} castShadow />
      <ambientLight intensity={2.2} />
      {/*
        A soft shadow pooled under the feet. Without it the character floats,
        which reads worst over a photographic plate, where there is no grid to
        give the eye a ground plane.

        The y offset must stay <= 0. ContactShadows parents its depth camera to
        this group, but the plane it blurs through is a standalone mesh left at
        world y=0. Raise the group and that blur plane drops behind the camera's
        near plane, both blur passes draw nothing, and the second one writes
        that nothing back over the render target: the shadow silently vanishes
        with no error and a perfectly healthy-looking scene graph. A previous
        +0.005 to dodge grid z-fighting did exactly that. Offset downwards
        instead, which clears the grid and keeps the blur plane in frustum.
      */}
      <ContactShadows
        position={[0, -0.002, 0]}
        scale={4}
        far={2.2}
        blur={2.6}
        opacity={0.65}
        resolution={1024}
        color="#000000"
      />
    </Canvas>
  );
}
