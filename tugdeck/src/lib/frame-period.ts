/**
 * The display period assumed before one is measured: the settle probes use
 * it when a run carries too few gaps to derive one, and the ingest host
 * paces its batches at it until the page learns the display's own. It lives
 * alone so the connection can read it without importing the probes.
 */
export const FALLBACK_FRAME_PERIOD_MS = 1000 / 60;
