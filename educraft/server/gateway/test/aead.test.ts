import { describe, expect, it } from 'vitest';
import { AeadStream, aeadLock, deriveClientKeys, publicKey } from '../src/aead';
import v from './vectors/monocypher.json';

const h = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const x = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('Monocypher port (vectors from the server source, test/vectors/gen.cpp)', () => {
  it('incremental aead_write ratchets like crypto_aead_write', () => {
    const s = new AeadStream(h(v.key), h(v.nonce));
    const [mac1, c1] = s.write(h(v.m1));
    const [mac2, c2] = s.write(h(v.m2));
    expect([x(mac1), x(c1), x(mac2), x(c2)]).toEqual([v.mac1, v.c1, v.mac2, v.c2]);
  });

  it('aead_read decrypts in order and rejects a bad MAC without ratcheting', () => {
    const r = new AeadStream(h(v.key), h(v.nonce));
    const bad = h(v.mac1);
    bad[0] ^= 1;
    expect(r.read(bad, h(v.c1))).toBeNull();
    expect(x(r.read(h(v.mac1), h(v.c1))!)).toBe(v.m1);
    expect(x(r.read(h(v.mac2), h(v.c2))!)).toBe(v.m2);
  });

  it('aead_lock with associated data', () => {
    const [mac, ct] = aeadLock(h(v.key), h(v.nonce), h(v.ad), h(v.lockMsg));
    expect([x(mac), x(ct)]).toEqual([v.lockMac, v.lockCipher]);
  });

  it('x25519 + blake2b key derivation matches X25519DerivedKeys::Exchange (client side)', () => {
    expect(x(publicKey(h(v.clientSecret)))).toBe(v.clientPublic);
    const [c2s, s2c] = deriveClientKeys(h(v.clientSecret), h(v.serverPublic))!;
    expect(x(c2s) + x(s2c)).toBe(v.derived);
  });

  it('refuses a low-order server key (all-zero shared secret)', () => {
    expect(deriveClientKeys(h(v.clientSecret), new Uint8Array(32))).toBeNull();
  });
});
