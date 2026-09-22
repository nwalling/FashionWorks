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
