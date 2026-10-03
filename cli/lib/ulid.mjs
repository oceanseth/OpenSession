/**
 * ULID encoding (Crockford base32: 48-bit timestamp + 80-bit entropy).
 *
 * Two constructors:
 *  - ulid(): random, for records born here.
 *  - deterministicUlid(tsMs, seed): entropy is the first 80 bits of
 *    SHA-256(seed) — the same source record always yields the same ULID, so
 *    re-importing a transcript (lost state, second machine, union merge)
 *    emits byte-identical ids and readers dedupe instead of duplicating.
 */
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(tsMs) {
  let t = tsMs;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeBytes(bytes) {
  // 10 bytes → 16 base32 chars (80 bits, 5 bits per char).
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.slice(0, 16);
}

export function ulid(tsMs = Date.now()) {
  return encodeTime(tsMs) + encodeBytes(randomBytes(10));
}

export function deterministicUlid(tsMs, seed) {
  const digest = createHash('sha256').update(seed).digest();
  return encodeTime(tsMs) + encodeBytes(digest.subarray(0, 10));
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
