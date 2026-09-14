import { Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Environment, Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';

import { useStore } from '../store';
import { SLOTS } from '../manifest';
import { ArmorPiece } from './ArmorPiece';
import { BACKDROPS, Backdrop, type BackdropName } from './Backdrop';
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

export function Scene({
  preset,
  backdrop,
  pose,
  onReady,
}: {
  preset: HdrPreset;
  backdrop: BackdropName;
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

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
    >
      <CaptureBridge onReady={onReady} />
      <PerspectiveCamera makeDefault position={[0, 1.25, 3.1]} fov={38} />
      <OrbitControls target={[0, 1.05, 0]} enableDamping minDistance={1.1} maxDistance={7} />
      <color attach="background" args={['#0d0f12']} />

      <Suspense fallback={null}>
        <Environment preset={preset} />
        {BACKDROPS[backdrop] ? <Backdrop file={BACKDROPS[backdrop]} /> : null}
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
      {BACKDROPS[backdrop] ? null : (
        <Grid
          args={[12, 12]}
          cellColor="#1d2228"
          sectionColor="#2b333c"
          infiniteGrid
          fadeDistance={16}
          position={[0, 0, 0]}
        />
      )}
      <directionalLight position={[3, 5, 2]} intensity={1.1} castShadow />
      <ambientLight intensity={0.25} />
    </Canvas>
  );
}
