/** `@fashionworks/web` — the public surface.
 *
 * One React component, client-only. The visitor points it at their own
 * `Data.p4k` and everything -- reading the archive, extracting armour,
 * compositing, rendering -- happens in their browser. **The host serves no game
 * data, runs no server code for this page, and stores nothing.**
 *
 * The contract this implements is `WEB-INTEGRATION.md`; that file is written
 * for the Hangarworks side and is the one to read first.
 */

export { FashionWorks } from './FashionWorks';
export type { FashionWorksProps, FashionWorksErrorCode } from './FashionWorks';

// Theming is exported because a host may want to check its own themes against
// the component's contrast requirements in its own tests.
export {
  checkContrast,
  contrast,
  luminance,
  readTokens,
  watchTheme,
  TOKENS,
  AA_TEXT,
  AA_LARGE,
} from './theme';
export type { Tokens, TokenName, ContrastCheck } from './theme';

// The archive worker and the catalogue it builds. Exported so a host can drive
// the pipeline itself, and so the built package can be exercised end to end by
// a verification page rather than only from source.
export { ArchiveClient, coreUrl } from './archive/client';
export type { OpenResult, OpenHandlers } from './archive/client';
export {
  readCatalogue,
  familyRoot,
  lineKey,
  lineOf,
  lineTitle,
  lineRepresentative,
  productLine,
  sharedName,
  colourwayName,
  displayName,
  swatchColour,
  SLOTS,
  GEAR_SLOTS,
  isGearSlot,
  HIDDEN_FLAGS,
} from './archive/catalogue';
export type { Catalogue, CatalogueItem, Slot, GearSlot, Port } from './archive/catalogue';
export {
  resolvePorts,
  refusal,
  portFor,
  portLabel,
  portServes,
  describePorts,
  isHolster,
  PORT_OWNERS,
} from './gear/ports';
export type { OwnedPort } from './gear/ports';

// The kitbasher itself, below the `FashionWorks` wrapper: a host that has its
// own archive handling, or a verification page that opens one over HTTP, can
// render the listing and the body without going through the file picker.
export { Kitbasher } from './ui/Kitbasher';
export type { KitbasherProps } from './ui/Kitbasher';
export {
  Kitbasher as KitbasherEngine,
  POSES,
  encodeLoadout,
  decodeLoadout,
  decodeGear,
  WEAPON_POSES,
  matchSet,
  paletteOf,
} from './three/kitbasher';
export { SET_MATCH_THRESHOLD } from './three/kitbasher';
export type { KitbasherState, KitbasherScene, Pose, SetPlan, Body } from './three/kitbasher';
