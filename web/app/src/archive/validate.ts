/** Deciding whether the file the visitor dropped is a usable `Data.p4k`.
 *
 * WEB.md's onboarding step 3 asks for *plain-language failures, each with a
 * next step*. That is the whole design brief here: every way this can fail has
 * a named case and a sentence that tells the visitor what to do, because the
 * alternative is a stack trace on a page that just ate a 158 GB drag-and-drop.
 *
 * Nothing in this module reads the archive itself. It takes an already-indexed
 * archive through {@link IndexedArchive}, so the same checks run against the
 * real wasm `Archive` and against a fake in a test.
 */

/** The part of the wasm `Archive` validation needs. */
export interface IndexedArchive {
  entryCount(): number;
  hasEntry(path: string): boolean;
  countUnder(prefix: string): number;
  fingerprint(): string;
}

export type ValidationCode =
  | 'ok'
  | 'not-an-archive'
  | 'wrong-file'
  | 'incomplete'
  | 'unsupported-build';

export interface ValidationFailure {
  readonly code: Exclude<ValidationCode, 'ok'>;
  readonly title: string;
  /** What the visitor should do next. */
  readonly detail: string;
  /** True when asking in Discord is the sensible next step. */
  readonly reportable: boolean;
}

export interface ValidationSuccess {
  readonly code: 'ok';
  readonly fingerprint: string;
  readonly entryCount: number;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/** The smallest a real archive could be. The 4.10 build is 147.6 GB; even a
 * fresh channel with almost nothing installed is tens of gigabytes. A file
 * under this is a partial download or the wrong file entirely. */
export const MINIMUM_BYTES = 8 * 1024 ** 3;

/** Entries the pipeline cannot start without.
 *
 * `Game2.dcb` is the DataCore -- every item record. `global.ini` resolves
 * `@item_Name_<class>` keys; without it every piece shows its class name.
 */
export const REQUIRED_ENTRIES = [
  'Data\\Game2.dcb',
  'Data\\Localization\\english\\global.ini',
] as const;

/** Armour lives under here. An archive with none is a real P4K from a build
 * whose layout this tool does not know. */
export const ARMOUR_PREFIX = 'Data\\Objects\\Characters\\Human\\male_v7\\armor';

/** Below this, the archive is structurally fine and has nothing to show. */
export const MINIMUM_ARMOUR_ENTRIES = 100;

const DISCORD = 'the Hangarworks Discord';

/** A first look at the file, before any of it is read.
 *
 * Separate from {@link validateArchive} because it costs nothing and catches
 * the commonest mistakes -- the shortcut, the `.exe`, the half-downloaded
 * archive -- before the visitor waits through an index.
 */
export function inspectFile(file: { name: string; size: number }): ValidationFailure | null {
  const name = file.name.toLowerCase();

  if (!name.endsWith('.p4k')) {
    return {
      code: 'wrong-file',
      title: `That is ${file.name}, not Data.p4k`,
      detail: 'Look for the file called exactly "Data.p4k" in your StarCitizen\\LIVE folder. '
        + 'It is the largest file there.',
      reportable: false,
    };
  }

  if (file.size === 0) {
    return {
      code: 'wrong-file',
      title: 'That file is empty',
      detail: 'This can happen when a shortcut is dragged instead of the file itself. '
        + 'Open the LIVE folder and drag Data.p4k from there.',
      reportable: false,
    };
  }

  if (file.size < MINIMUM_BYTES) {
    return {
      code: 'incomplete',
      title: 'That archive looks incomplete',
      detail: `Data.p4k is well over 100 GB and this one is ${formatBytes(file.size)}. `
        + 'If the RSI Launcher is still downloading or verifying, let it finish and try again.',
      reportable: false,
    };
  }

  return null;
}

/** Whether an indexed archive is one this tool can work with. */
export function validateArchive(archive: IndexedArchive): ValidationResult {
  const entries = archive.entryCount();
  if (entries === 0) {
    return {
      code: 'not-an-archive',
      title: 'That is not a Star Citizen archive',
      detail: 'The file opened but contains no entries. Make sure you picked Data.p4k from '
        + 'your StarCitizen install and not another file with the same extension.',
      reportable: false,
    };
  }

  const missing = REQUIRED_ENTRIES.filter((path) => !archive.hasEntry(path));
  if (missing.length > 0) {
    return {
      code: 'unsupported-build',
      title: 'This game build is not supported yet',
      detail: `The archive opened and indexed ${entries.toLocaleString()} files, but `
        + `${missing.map(shortName).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} `
        + `not where this tool expects. That usually means Star Citizen moved something in a `
        + `patch. Please report it in ${DISCORD} with your game version.`,
      reportable: true,
    };
  }

  const armour = archive.countUnder(ARMOUR_PREFIX);
  if (armour < MINIMUM_ARMOUR_ENTRIES) {
    return {
      code: 'unsupported-build',
      title: 'This game build is not supported yet',
      detail: `The archive is valid but holds only ${armour} armour files, where this build `
        + `should have thousands. The layout has probably changed. Please report it in `
        + `${DISCORD} with your game version.`,
      reportable: true,
    };
  }

  return { code: 'ok', fingerprint: archive.fingerprint(), entryCount: entries };
}

function shortName(path: string): string {
  const parts = path.split('\\');
  return parts[parts.length - 1] ?? path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
