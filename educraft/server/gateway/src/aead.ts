/**
 * Port of the pieces of Monocypher 4 the OpenTTD admin port uses (contract §4.2):
 * the incremental AEAD (crypto_aead_init_x / _write / _read) and the X25519 +
 * BLAKE2b key derivation of X25519DerivedKeys::Exchange (src/network/network_crypto.cpp).
 * Primitives come from @noble; only the composition is ported. Vectors: test/vectors.
 */
import { chacha20orig, hchacha } from '@noble/ciphers/chacha.js';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function u32(b: Uint8Array): Uint32Array {
  const out = new Uint32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24);
  }
  return out;
}

function bytes(w: Uint32Array): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  for (let i = 0; i < w.length; i++) {
    out[i * 4] = w[i] & 0xff;
    out[i * 4 + 1] = (w[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (w[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (w[i] >>> 24) & 0xff;
  }
  return out;
}

function le64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

function pad16(n: number): Uint8Array {
  return new Uint8Array((16 - (n % 16)) % 16);
}

/** Monocypher lock_auth: Poly1305 over ad|pad|ct|pad|le64(ad)|le64(ct). */
function lockAuth(authKey: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array {
  const parts = [ad, pad16(ad.length), ct, pad16(ct.length), le64(ad.length), le64(ct.length)];
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return poly1305(all, authKey);
}

function equal16(a: Uint8Array, b: Uint8Array): boolean {
  let d = 0;
  for (let i = 0; i < 16; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** crypto_aead_ctx initialised with crypto_aead_init_x. The key ratchets after every message. */
export class AeadStream {
  private key: Uint8Array;
  private readonly nonce: Uint8Array;

  constructor(key: Uint8Array, nonce24: Uint8Array) {
    const sub = new Uint32Array(8);
    hchacha(SIGMA, u32(key), u32(nonce24.subarray(0, 16)), sub);
    this.key = bytes(sub);
    this.nonce = nonce24.slice(16, 24);
  }

  private authKey(): Uint8Array {
    return chacha20orig(this.key, this.nonce, new Uint8Array(64), undefined, 0);
  }

  /** crypto_aead_write: returns [mac, ciphertext]. */
  write(plain: Uint8Array, ad: Uint8Array = new Uint8Array(0)): [Uint8Array, Uint8Array] {
    const ak = this.authKey();
    const ct = chacha20orig(this.key, this.nonce, plain, undefined, 1);
    const mac = lockAuth(ak.subarray(0, 32), ad, ct);
    this.key = ak.slice(32, 64);
    return [mac, ct];
  }

  /** crypto_aead_read: plaintext, or null on a MAC mismatch (the key does not ratchet then). */
  read(mac: Uint8Array, ct: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array | null {
    const ak = this.authKey();
    if (!equal16(mac, lockAuth(ak.subarray(0, 32), ad, ct))) return null;
    const plain = chacha20orig(this.key, this.nonce, ct, undefined, 1);
    this.key = ak.slice(32, 64);
    return plain;
  }
}

/** crypto_aead_lock (one-shot). */
export function aeadLock(key: Uint8Array, nonce24: Uint8Array, ad: Uint8Array, plain: Uint8Array): [Uint8Array, Uint8Array] {
  return new AeadStream(key, nonce24).write(plain, ad);
}

export function publicKey(secret: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secret);
}

/**
 * X25519DerivedKeys::Exchange for the CLIENT side: blake2b-512(shared | server pk | client pk | extra).
 * Returns [clientToServer, serverToClient], or null for an all-zero shared secret.
 */
export function deriveClientKeys(
  ourSecret: Uint8Array,
  serverPublic: Uint8Array,
  extra: Uint8Array = new Uint8Array(0),
): [Uint8Array, Uint8Array] | null {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(ourSecret, serverPublic);
  } catch {
    return null; // noble refuses low-order points, i.e. the all-zero shared secret
  }
  if (shared.every((b) => b === 0)) return null;
  const ourPublic = publicKey(ourSecret);
  const input = new Uint8Array(32 + 32 + 32 + extra.length);
  input.set(shared, 0);
  input.set(serverPublic, 32);
  input.set(ourPublic, 64);
  input.set(extra, 96);
  const keys = blake2b(input, { dkLen: 64 });
  return [keys.slice(0, 32), keys.slice(32, 64)];
}
