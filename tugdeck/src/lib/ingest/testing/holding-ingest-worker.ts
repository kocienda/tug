/**
 * The ingest Worker with its batches held back by `hold-batches.ts`. The
 * import order is the point: modules evaluate in it, so the wrapped
 * `postMessage` is in place before the entry's first post.
 */

import "./hold-batches";
import "../../workers/ingest-worker";
