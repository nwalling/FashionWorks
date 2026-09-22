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
  sharedName,
  colourwayName,
  displayName,
  SLOTS,
  HIDDEN_FLAGS,
} from './archive/catalogue';
export type { Catalogue, CatalogueItem, Slot } from './archive/catalogue';
