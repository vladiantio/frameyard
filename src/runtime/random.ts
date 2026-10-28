/**
 * Returns a deterministic value in [0, 1) derived only from the supplied key.
 *
 * The calculation is stateless: call order and previous frames cannot affect
 * the result. Use stable, descriptive keys such as `random("star:17:y")`.
 */
export function random(key: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  // MurmurHash3's 32-bit finalizer spreads adjacent keys across the range.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;

  return (hash >>> 0) / 0x1_0000_0000;
}
