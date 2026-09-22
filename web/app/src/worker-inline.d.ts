/** Vite's inline-worker import form.
 *
 * `?worker&inline` bundles the worker to a self-contained module and hands
 * back a constructor, which is what lets the published package carry its own
 * worker without a consumer bundler having to resolve one out of node_modules.
 * Vite ships types for `?worker` but the build here goes through `tsc` for
 * declarations, which does not know the query form.
 */
declare module '*?worker&inline' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
