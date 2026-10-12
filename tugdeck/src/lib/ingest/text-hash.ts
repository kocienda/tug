/**
 * `textHash` — FNV-1a 64 over a string's UTF-8 bytes, as a decimal string.
 *
 * This is tugcast's `tugmark::text_hash`, the identity a rendered record
 * carries for the text it rendered. The page compares it with the Message's
 * own text once, when the Message finalizes, so the arithmetic runs over four
 * 16-bit limbs rather than `BigInt`: every intermediate product fits a
 * double exactly, and the hash is cheap enough to run on the ingest Worker
 * per finalization.
 *
 * Pure — no DOM, no Worker globals beyond `TextEncoder`.
 */

const utf8 = new TextEncoder();

/** FNV-1a 64 over `text`'s UTF-8 bytes, in decimal. */
export function textHash(text: string): string {
  // The offset basis 0xcbf29ce484222325, low limb first.
  let v0 = 0x2325;
  let v1 = 0x8422;
  let v2 = 0x9ce4;
  let v3 = 0xcbf2;
  for (const byte of utf8.encode(text)) {
    v0 ^= byte;
    // Multiply by the prime 0x100000001b3: `* 0x1b3`, plus the value
    // shifted left by 40 bits, which lands limbs 0 and 1 on limbs 2 and 3
    // shifted by 8.
    let t0 = v0 * 0x1b3;
    let t1 = v1 * 0x1b3;
    let t2 = v2 * 0x1b3;
    let t3 = v3 * 0x1b3;
    t2 += v0 << 8;
    t3 += v1 << 8;
    t1 += t0 >>> 16;
    v0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    v1 = t1 & 0xffff;
    t3 += t2 >>> 16;
    v2 = t2 & 0xffff;
    v3 = t3 & 0xffff;
  }
  return limbsToDecimal([v3, v2, v1, v0]);
}

/** A 64-bit value held as 16-bit limbs, high first, in decimal. */
function limbsToDecimal(limbs: number[]): string {
  const value = [...limbs];
  const chunks: number[] = [];
  // Long division by 10^4: every step's dividend stays under 2^30.
  while (value.some((limb) => limb !== 0)) {
    let rem = 0;
    for (let i = 0; i < value.length; i += 1) {
      const cur = rem * 0x10000 + value[i]!;
      value[i] = Math.floor(cur / 10000);
      rem = cur % 10000;
    }
    chunks.push(rem);
  }
  if (chunks.length === 0) return "0";
  let out = String(chunks[chunks.length - 1]);
  for (let i = chunks.length - 2; i >= 0; i -= 1) out += String(chunks[i]).padStart(4, "0");
  return out;
}
