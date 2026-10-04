import net from 'node:net';
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Registry } from '../src/bridge';
import { CLOSE_UNAUTHORIZED, LoopbackPool, createGateway } from '../src/proxy';
import { TicketVerifier, signTicket, type Ticket } from '../src/ticket';

const KEY = randomBytes(32);
const GAME = 'c3f0c9a1b2c4d';
const NOW = 1_800_000_000;
const t = (over: Partial<Ticket> = {}): Ticket => ({ g: GAME, s: 's-1', r: 'pupil', iat: NOW, exp: NOW + 120, n: randomBytes(16).toString('base64url'), ...over });

describe('ticket verification (§6.3, §6.4)', () => {
  const v = () => new TicketVerifier(KEY, GAME, NOW - 10);

  it('accepts a valid pupil ticket once (replay refused)', () => {
    const verifier = v();
    const tok = signTicket(KEY, t());
    expect(verifier.verify(tok, NOW + 1)).toMatchObject({ s: 's-1', r: 'pupil' });
    expect(verifier.verify(tok, NOW + 2)).toBeNull();
  });

  it('refuses expired, bad signature, other game, too long lived and missing pupil', () => {
    const verifier = v();
    expect(verifier.verify(signTicket(KEY, t()), NOW + 120)).toBeNull();
    expect(verifier.verify(signTicket(randomBytes(32), t()), NOW)).toBeNull();
    const [body] = signTicket(KEY, t()).split('.');
    expect(verifier.verify(`${body}.${signTicket(KEY, t()).split('.')[1]}`, NOW)).toBeNull();
    expect(verifier.verify(signTicket(KEY, t({ g: 'c000000000000' })), NOW)).toBeNull();
    expect(verifier.verify(signTicket(KEY, t({ exp: NOW + 600 })), NOW)).toBeNull();
    expect(verifier.verify(signTicket(KEY, t({ s: null })), NOW)).toBeNull();
    expect(verifier.verify(null, NOW)).toBeNull();
    expect(verifier.verify('garbage', NOW)).toBeNull();
  });

  it('refuses tickets issued before the gateway started', () => {
    expect(new TicketVerifier(KEY, GAME, NOW + 1).verify(signTicket(KEY, t()), NOW + 2)).toBeNull();
  });

  it('mayor tickets are accepted without a pupil; unknown roles are refused', () => {
    const verifier = v();
    expect(verifier.verify(signTicket(KEY, t({ r: 'mayor', s: 'ignored' })), NOW)).toMatchObject({ r: 'mayor', s: null });
    expect(verifier.verify(signTicket(KEY, t({ r: 'admin' as any })), NOW)).toBeNull();
  });

  it('spectator tickets carry no pupil', () => {
    expect(v().verify(signTicket(KEY, t({ r: 'spectator', s: 'ignored' })), NOW)).toMatchObject({ r: 'spectator', s: null });
  });
});

describe('LoopbackPool', () => {
  it('hands out distinct 127.77.x.y addresses and reuses freed ones last', () => {
    const p = new LoopbackPool();
    const a = p.take()!;
    const b = p.take()!;
    expect([a, b]).toEqual(['127.77.0.1', '127.77.0.2']);
    p.free(a);
    expect(p.take()).toBe('127.77.0.3');
  });
});

describe('WSS → TCP proxy', () => {
  let game: net.Server | undefined;
  let gw: http.Server | undefined;
  afterEach(() => {
    game?.close();
    gw?.close();
  });

  const listen = (s: net.Server | http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

  async function setup(startedAt: number, spectatorCap?: number) {
    const peers: string[] = [];
    game = net.createServer((sock) => {
      peers.push(sock.remoteAddress!);
      sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    const gamePort = await listen(game);
    const registry: Registry = new Map();
    gw = createGateway({
      gameKey: GAME,
      verifier: new TicketVerifier(KEY, GAME, startedAt),
      registry,
      gameHost: '127.0.0.1',
      gamePort,
      log: () => {},
      spectatorCap,
    });
    const port = await listen(gw);
    return { peers, registry, url: (tok: string) => `ws://127.0.0.1:${port}/g/${GAME}?t=${encodeURIComponent(tok)}` };
  }

  it('pipes bytes to the game port from a per-connection loopback address', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { peers, registry, url } = await setup(now - 5);
    const ws = new WebSocket(url(signTicket(KEY, t({ iat: now, exp: now + 120 }))), 'binary');
    await new Promise((r) => ws.on('open', r));
    ws.send(Buffer.from('hi'));
    const reply = await new Promise<Buffer>((r) => ws.on('message', (d) => r(d as Buffer)));
    expect(reply.toString()).toBe('echo:hi');
    expect(peers).toEqual(['127.77.0.1']);
    expect(registry.get('127.77.0.1')).toEqual({ studentId: 's-1', role: 'pupil' });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.size).toBe(0);
  });

  it('caps spectators (1013 busy) but never mayors or pupils', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { registry, url } = await setup(now - 5, 2);
    registry.set('127.77.9.1', { studentId: null, role: 'spectator' });
    registry.set('127.77.9.2', { studentId: null, role: 'spectator' });
    const open = (tk: Partial<Ticket>) =>
      new Promise<number>((r) => {
        // The server closes right after the handshake when it refuses; 4000 = we closed an accepted one.
        const ws = new WebSocket(url(signTicket(KEY, t({ iat: now, exp: now + 120, ...tk }))), 'binary');
        ws.on('open', () => setTimeout(() => ws.readyState === ws.OPEN && ws.close(4000), 50));
        ws.on('close', (c) => r(c));
      });
    expect(await open({ r: 'spectator', s: null })).toBe(1013);
    expect(await open({ r: 'mayor', s: null })).toBe(4000);
    expect(await open({ r: 'pupil' })).toBe(4000);
  });

  it('closes 4401 for a ticket older than the process', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { peers, url } = await setup(now);
    const ws = new WebSocket(url(signTicket(KEY, t({ iat: now - 1, exp: now + 100 }))), 'binary');
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(CLOSE_UNAUTHORIZED);
    expect(peers).toEqual([]);
  });

  it('serves /healthz and rejects other paths', async () => {
    const { url } = await setup(0);
    const port = (gw!.address() as net.AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const ws = new WebSocket(url('x').replace(`/g/${GAME}`, '/g/c000000000000'));
    const err = await new Promise<Error>((r) => ws.on('error', r));
    expect(String(err)).toMatch(/404/);
  });
});
