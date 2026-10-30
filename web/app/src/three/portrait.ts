/** A portrait of the figure: the player's own face and outfit, head and
 * shoulders, on a gradient, as a square JPEG to download. Used as an avatar
 * on Hangarworks, where it is cropped to a circle and drawn as small as
 * 34 px in member lists -- which is why the head is large in the frame.
 *
 * The 3D side is two captures of the same frame over two flat greys
 * (`ViewerHandle.capture`), solved here for coverage and colour in linear
 * light, where the tone curve is affine. The gradient goes on afterwards in
 * 2D, so changing it needs no new render. Nothing here uploads anything: the
 * picture is the visitor's to save (WEB-LEGAL.md).
 */

/** Where a capture looks from. */
export interface CaptureView {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly fov: number;
}

/** A capture's frames, RGBA, one per grey, and each grey as displayed. */
export interface CaptureResult {
  readonly frames: Uint8ClampedArray[];
  readonly backgrounds: Array<[number, number, number]>;
}

/** A background the visitor can pick: a host theme's colours, or the
 * neutral default. `from` is the light behind the head, `to` the corners. */
export interface PortraitBackground {
  readonly id: string;
  readonly name: string;
  /** `#rrggbb` */
  readonly from: string;
  /** `#rrggbb` */
  readonly to: string;
}

/** What a standalone FashionWorks offers: a slate glow, dark at the edge. */
export const DEFAULT_BACKGROUND: PortraitBackground = {
  id: 'neutral',
  name: 'Neutral',
  from: '#3b4756',
  to: '#0f1418',
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The host's backgrounds, keeping only well-formed ones; the default when
 * none survive. Order is kept, so the host's first entry is preselected. */
export function portraitBackgrounds(input?: readonly PortraitBackground[] | null): PortraitBackground[] {
  const seen = new Set<string>();
  const valid = (input ?? []).filter((b) => b && typeof b.id === 'string' && b.id && !seen.has(b.id)
    && typeof b.name === 'string' && HEX.test(b.from ?? '') && HEX.test(b.to ?? '')
    && Boolean(seen.add(b.id)));
  return valid.length ? valid : [DEFAULT_BACKGROUND];
}

/** The size the downloaded picture is, square. Hangarworks downsizes to 512
 * on the web; iOS and Android upload the file as is. */
export const PORTRAIT_SIZE = 1024;
/** The largest file the apps upload unchanged. */
export const PORTRAIT_MAX_BYTES = 500_000;
/** The size the frame is rendered at before it is scaled down, for edges a
 * little cleaner than the multisampling alone gives. */
export const CAPTURE_SIZE = 2048;
/** The two greys behind the figure, linear. */
export const CAPTURE_GREYS: readonly [number, number] = [0.2, 0.8];

/** Head and shoulders, by the `Head` bone. */
export const FRAMING = {
  /** Degrees. Long, so the face is not distorted at this distance. */
  fov: 18,
  /** How far round toward the figure's left the camera stands, degrees. */
  azimuth: 25,
  /** How far above the face it looks down from, degrees. */
  elevation: 4,
  /** The frame's height in metres: the whole head with a helmet on, and the
   * top of the shoulders. */
  height: 0.46,
  /** Where the frame's centre sits relative to the bone, metres up. */
  lift: 0.0,
} as const;

/** Where the camera stands and what it looks at, from the head bone's world
 * position. The figure faces negative z (Viewer's opening camera faces the
 * visor), so the camera is on that side. */
export function portraitView(head: readonly [number, number, number], framing = FRAMING): {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
} {
  const az = (framing.azimuth * Math.PI) / 180;
  const el = (framing.elevation * Math.PI) / 180;
  const direction = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const target: [number, number, number] = [head[0], head[1] + framing.lift, head[2]];
  const distance = framing.height / 2 / Math.tan((framing.fov * Math.PI) / 360);
  const position: [number, number, number] = [
    target[0] + direction[0]! * distance,
    target[1] + direction[1]! * distance,
    target[2] + direction[2]! * distance,
  ];
  return { position, target, fov: framing.fov };
}

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

function linearToSrgbByte(l: number): number {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** The figure alone, straight alpha, from the same frame over a dark and a
 * light background, and those backgrounds as the screen shows them.
 *
 * Over two backgrounds a pixel differs by exactly how much of the background
 * shows through it, so coverage is the difference over the backgrounds'
 * difference, and the colour is what is left of the dark capture once the
 * background's share is taken away. In linear light, where the tone curve
 * is affine over this range -- the item renders solve their cut-outs the same
 * way. */
export function solveCutout(
  dark: Uint8ClampedArray,
  light: Uint8ClampedArray,
  darkBackground: readonly [number, number, number],
  lightBackground: readonly [number, number, number],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(dark.length);
  const bd = darkBackground.map((v) => SRGB_TO_LINEAR[v]!);
  const bl = lightBackground.map((v) => SRGB_TO_LINEAR[v]!);
  const span = [0, 1, 2].map((k) => Math.max(1e-4, bl[k]! - bd[k]!));
  for (let i = 0; i < dark.length; i += 4) {
    let alpha = 0;
    for (let k = 0; k < 3; k += 1) {
      alpha += 1 - (SRGB_TO_LINEAR[light[i + k]!]! - SRGB_TO_LINEAR[dark[i + k]!]!) / span[k]!;
    }
    alpha = Math.min(1, Math.max(0, alpha / 3));
    if (alpha > 0.004) {
      for (let k = 0; k < 3; k += 1) {
        out[i + k] = linearToSrgbByte((SRGB_TO_LINEAR[dark[i + k]!]! - (1 - alpha) * bd[k]!) / alpha);
      }
    }
    out[i + 3] = Math.round(alpha * 255);
  }
  return out;
}

/** The gradient: the background's light colour round the head, its dark
 * colour by the corners, blended in linear light so the falloff has no
 * muddy middle. Centred a little above the middle, where the face is. */
function paintBackground(context: OffscreenCanvasRenderingContext2D, background: PortraitBackground, size: number): void {
  const gradient = context.createRadialGradient(size * 0.5, size * 0.42, size * 0.04, size * 0.5, size * 0.46, size * 0.74);
  const from = hexBytes(background.from);
  const to = hexBytes(background.to);
  const stops = 8;
  for (let s = 0; s <= stops; s += 1) {
    const t = s / stops;
    const rgb = from.map((f, k) => linearToSrgbByte(
      SRGB_TO_LINEAR[f]! + (SRGB_TO_LINEAR[to[k]!]! - SRGB_TO_LINEAR[f]!) * t,
    ));
    gradient.addColorStop(t, `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
}

function hexBytes(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The figure over its background, at `size`. The cut-out is scaled down in
 * halves, which keeps edges sharper than one large step. */
export function composePortrait(cutout: OffscreenCanvas, background: PortraitBackground, size = PORTRAIT_SIZE): OffscreenCanvas {
  let source: OffscreenCanvas = cutout;
  while (source.width / 2 >= size) {
    const half = new OffscreenCanvas(source.width / 2, source.height / 2);
    const g = half.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, half.width, half.height);
    source = half;
  }
  const out = new OffscreenCanvas(size, size);
  const context = out.getContext('2d')!;
  paintBackground(context, background, size);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, size, size);
  return out;
}

/** The picture as a JPEG no larger than `maxBytes`, stepping the quality down
 * until it fits. A head and shoulders at 1024 px is usually 150-300 KB at the
 * first step. */
export async function encodePortrait(canvas: OffscreenCanvas, maxBytes = PORTRAIT_MAX_BYTES): Promise<Blob> {
  let blob: Blob | null = null;
  for (const quality of [0.92, 0.88, 0.84, 0.8, 0.74, 0.68, 0.6]) {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= maxBytes) return blob;
  }
  return blob!;
}

/** A file name for the download: the character's, else the tool's. */
export function portraitFileName(character: string | null): string {
  const base = (character ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${base || 'fashionworks'}-portrait.jpg`;
}
