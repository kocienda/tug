/**
 * The ingest Worker with its batches stamped by `count-ahead.ts`. The import
 * order is the point: modules evaluate in it, so the counter's listener is in
 * place before the entry's.
 */

import "./count-ahead";
import "../../workers/ingest-worker";
