/** Hand the visitor a file the page made. Nothing is uploaded: the file goes
 * from this page to their downloads folder (WEB-LEGAL.md). */

/** How long a download's object URL is kept: `click()` only queues the
 * navigation, and revoking at once can lose the file (CLAUDE.md). */
const OBJECT_URL_TTL_MS = 60_000;

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  // Attached first: Firefox ignores a click on a detached anchor.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
}
