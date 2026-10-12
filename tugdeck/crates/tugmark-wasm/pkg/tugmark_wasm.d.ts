/* tslint:disable */
/* eslint-disable */

/**
 * FNV-1a 64-bit content hash per top-level block, 2 words per block
 * (low, high), in [`lex_blocks`]'s order.
 */
export function lex_block_hashes(text: string): Uint32Array;

/**
 * Lex markdown into packed binary block metadata.
 * Returns Vec<u32> — 4 words per block. JS receives a Uint32Array.
 */
export function lex_blocks(text: string): Uint32Array;

/**
 * Parse a whole markdown document in one pass and emit one HTML string
 * per top-level block, in [`lex_blocks`]'s order.
 */
export function parse_blocks_to_html(text: string): any[];

/**
 * Parse a markdown fragment to HTML, with no cross-block linking.
 */
export function parse_to_html(text: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly lex_block_hashes: (a: number, b: number) => [number, number];
    readonly lex_blocks: (a: number, b: number) => [number, number];
    readonly parse_blocks_to_html: (a: number, b: number) => [number, number];
    readonly parse_to_html: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
