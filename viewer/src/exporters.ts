import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

import type { Loadout } from './loadout';
import type { Manifest } from './manifest';

/**
 * How long the object URL is kept alive after the click.
 *
 * Revoking it on the next line races the download: `click()` only queues the
 * navigation, and the browser takes its reference to the blob after the event
 * has been dispatched. A revoked URL by then yields a failed or empty download,
 * and a combined GLB with `embedImages` is tens of megabytes, so it is the
 * export most likely to lose the race.
 */
const OBJECT_URL_TTL_MS = 60_000;

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Firefox ignores `click()` on an anchor that is not in the document.
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
}

/** Loadout + the game version it was built against (PLAN.md §5.5). */
export function exportLoadoutJson(loadout: Loadout, manifest: Manifest | null): void {
  const payload = {
    schema_version: manifest?.schema_version ?? null,
    game_version: manifest?.game_version ?? 'unknown',
    exported_at: new Date().toISOString(),
    loadout,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'loadout.json');
}

/** Combined .glb of the base character with everything currently equipped. */
export async function exportCombinedGlb(scene: THREE.Object3D): Promise<void> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, {
    binary: true,
    onlyVisible: true,
    embedImages: true,
    animations: [],
  });
  const blob =
    result instanceof ArrayBuffer
      ? new Blob([result], { type: 'model/gltf-binary' })
      : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
  download(blob, 'loadout.glb');
}

/** Canvas screenshot at the renderer's current pixel ratio. */
export function exportScreenshot(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  gl.render(scene, camera);
  gl.domElement.toBlob((blob) => {
    if (blob) download(blob, 'loadout.png');
  }, 'image/png');
}
