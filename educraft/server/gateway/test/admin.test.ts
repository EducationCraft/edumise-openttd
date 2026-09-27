import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminClient, type AdminEvents } from '../src/admin';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { AeadStream, publicKey } from '../src/aead';
import { Admin, FrameDecoder, Reader, Server, Writer, encodeFrame } from '../src/packet';

describe('packet framing (packet.cpp)', () => {
  it('encodes size | type | payload little-endian and decodes across arbitrary chunking', () => {
    const f = encodeFrame(Server.ClientInfo, new Writer().u32(0x01020304).str('127.77.0.1').str('žák').u8(0).u32(7).u8(255).build());
    expect([f[0] | (f[1] << 8), f[2]]).toEqual([f.length, Server.ClientInfo]);
    const d = new FrameDecoder();
    const got = [...f, ...encodeFrame(Server.Pong, new Writer().u32(9).build())].flatMap((b) => d.push(Uint8Array.of(b)));
    expect(got.map((p) => p.type)).toEqual([Server.ClientInfo, Server.Pong]);
    const r = new Reader(got[0].payload);
    expect([r.u32(), r.str(), r.str(), r.u8(), r.u32(), r.u8()]).toEqual([0x01020304, '127.77.0.1', 'žák', 0, 7, 255]);
  });

  it('encrypted frames carry a MAC and round-trip through two ratcheting streams', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(24);
    const tx = new AeadStream(key, nonce);
    const d = new FrameDecoder();
    d.dec = new AeadStream(key, nonce);
    const a = encodeFrame(Admin.GameScript, new Writer().str('{"t":"ping"}').build(), tx);
    const b = encodeFrame(Admin.Ping, new Writer().u32(1).build(), tx);
    expect(a.length).toBe(2 + 16 + 1 + 13);
    const out = d.push(Uint8Array.from([...a, ...b]));
    expect(out.map((p) => p.type)).toEqual([Admin.GameScript, Admin.Ping]);
    const bad = encodeFrame(Admin.Ping, new Writer().u32(1).build(), new AeadStream(key, nonce));
    expect(() => d.push(bad)).toThrow(/authentication/);
  });

  it('refuses a frame over the admin MTU', () => {
    expect(() => encodeFrame(Admin.GameScript, new Uint8Array(1460))).toThrow(/too large/);
  });
});

/**
 * A fake admin port that runs the SERVER side of the authorized-key handshake exactly as
 * network_crypto.cpp does (keys = blake2b(shared | server pk | client pk), unlock with AD = client pk).
 */
function fakeServer(authorized: Uint8Array, onReady: (send: (t: number, p: Uint8Array) => void, got: (t: number) => Promise<Reader>) => void) {
  return net.createServer((sock) => {
    const serverSecret = randomBytes(32);
    const serverPub = publicKey(serverSecret);
    const kxNonce = randomBytes(24);
    const encNonce = randomBytes(24);
    const dec = new FrameDecoder();
    let enc: AeadStream | undefined;
    const queue: { type: number; payload: Uint8Array }[] = [];
    const waiters: [number, (r: Reader) => void][] = [];
    const send = (t: number, p: Uint8Array) => sock.write(encodeFrame(t, p, enc));
    const deliver = () => {
      for (let i = 0; i < waiters.length; i++) {
        const idx = queue.findIndex((q) => q.type === waiters[i][0]);
        if (idx >= 0) {
          const [q] = queue.splice(idx, 1);
          waiters.splice(i--, 1)[0][1](new Reader(q.payload));
        }
      }
    };
    const got = (t: number) => new Promise<Reader>((res) => { waiters.push([t, res]); deliver(); });
    sock.on('data', (c) => { queue.push(...dec.push(c)); deliver(); });
    (async () => {
      const join = await got(Admin.JoinSecure);
      expect([join.str(), join.str(), join.u16()]).toEqual(['edumise-bridge', '1', 4]);
      send(Server.AuthRequest, new Writer().u8(2).bytes(serverPub).bytes(kxNonce).build());
      const resp = await got(Admin.AuthResponse);
      const clientPub = resp.bytes(32);
      const mac = resp.bytes(16);
      const ct = resp.bytes(8);
      // X25519DerivedKeys::Exchange, SERVER side: blake2b(shared | our (server) pk | peer (client) pk).
      const keys = blake2b(Uint8Array.from([...x25519.getSharedSecret(serverSecret, clientPub), ...serverPub, ...clientPub]), { dkLen: 64 });
      const [c2s, s2c] = [keys.slice(0, 32), keys.slice(32)];
      const ok = new AeadStream(c2s, kxNonce).read(mac, ct, clientPub) !== null && Buffer.from(clientPub).equals(Buffer.from(authorized));
      if (!ok) {
        send(Server.Error, new Writer().u8(10).build());
        return sock.end();
      }
      send(Server.EnableEncryption, new Writer().bytes(encNonce).build());
      dec.dec = new AeadStream(c2s, encNonce);
      enc = new AeadStream(s2c, encNonce);
      // Protocol + Welcome in one write, right behind the plaintext EnableEncryption.
      send(Server.Protocol, new Writer().u8(3).u8(0).build());
      send(Server.Welcome, new Writer().str('srv').str('rev').u8(1).str('').u32(42).u8(0).u32(712247).u16(256).u16(256).build());
      onReady(send, got);
    })();
  });
}

const events = (over: Partial<AdminEvents> = {}): AdminEvents => ({
  gs: () => {}, clientInfo: () => {}, clientUpdate: () => {}, clientQuit: () => {}, companyNew: () => {},
  companyInfo: () => {}, companyRemove: () => {}, closed: () => {}, ...over,
});

describe('AdminClient against a fake admin port', () => {
  let server: net.Server | undefined;
  afterEach(() => server?.close());

  const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

  it('authenticates with the authorized key, then speaks encrypted admin protocol', async () => {
    const secret = randomBytes(32);
    const seen: string[] = [];
    let serverSide!: { send: (t: number, p: Uint8Array) => void; got: (t: number) => Promise<Reader> };
    const ready = new Promise<void>((res) => {
      server = fakeServer(publicKey(secret), (send, got) => { serverSide = { send, got }; res(); });
    });
    const port = await listen(server!);
    const client = new AdminClient(secret, events({
      gs: (j) => seen.push(`gs ${j}`),
      clientInfo: (id, host, playas) => seen.push(`info ${id} ${host} ${playas}`),
    }));
    expect(await client.connect('127.0.0.1', port)).toMatchObject({ seed: 42, mapX: 256, revision: 'rev' });
    await ready;
    const freq = await serverSide.got(Admin.UpdateFrequency);
    expect([freq.u16(), freq.u16()]).toEqual([1, 64]);
    const poll = await serverSide.got(Admin.Poll);
    expect([poll.u8(), poll.u32()]).toEqual([2, 0xffffffff]);
    const clientPoll = await serverSide.got(Admin.Poll);
    expect([clientPoll.u8(), clientPoll.u32()]).toEqual([1, 0xffffffff]);

    const rcon = client.rcon('save current');
    const cmd = await serverSide.got(Admin.Rcon);
    expect(cmd.str()).toBe('save current');
    serverSide.send(Server.Rcon, new Writer().u16(1).str("Map successfully saved to 'current.sav'.").build());
    serverSide.send(Server.RconEnd, new Writer().str('save current').build());
    expect(await rcon).toEqual(["Map successfully saved to 'current.sav'."]);

    client.gs({ t: 'ping' });
    expect((await serverSide.got(Admin.GameScript)).str()).toBe('{"t":"ping"}');
    serverSide.send(Server.GameScript, new Writer().str('{"t":"pong","last":3}').build());
    serverSide.send(Server.ClientInfo, new Writer().u32(5).str('127.77.0.9').str('žák').u8(0).u32(1).u8(255).build());
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['gs {"t":"pong","last":3}', 'info 5 127.77.0.9 255']);
    expect(() => client.gs({ t: 'x', pad: 'a'.repeat(1500) })).toThrow(/1450/);
    client.close();
  });

  it('fails when the server does not know the key', async () => {
    server = fakeServer(publicKey(randomBytes(32)), () => {});
    const port = await listen(server);
    await expect(new AdminClient(randomBytes(32), events()).connect('127.0.0.1', port)).rejects.toThrow(/error 10/);
  });
});
