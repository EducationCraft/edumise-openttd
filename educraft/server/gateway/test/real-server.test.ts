/**
 * Integration against the real images; run by ../it/run.sh, skipped otherwise.
 * Phase "first": admin handshake + quiesce-free save into /data/save, WSS → TCP to the real
 * game port through the gateway (ticket admitted). Phase "restart": the same map came back.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AdminClient } from '../src/admin';
import { signTicket } from '../src/ticket';

const secret = process.env.OPENTTD_ADMIN_SECRET;
const phase = process.env.IT_PHASE ?? 'first';
const data = process.env.OPENTTD_DATA!;
const noop = () => {};
const events = { gs: noop, clientInfo: noop, clientUpdate: noop, clientQuit: noop, companyNew: noop, companyInfo: noop, companyRemove: noop, closed: noop };

async function connect() {
  const admin = new AdminClient(Uint8Array.from(Buffer.from(secret!, 'hex')), events, 'it-probe');
  const welcome = await admin.connect('127.0.0.1', Number(process.env.OPENTTD_ADMIN_PORT ?? 3977));
  return { admin, welcome };
}

describe.skipIf(!secret)('real OpenTTD server', () => {
  it.runIf(phase === 'first')('secure admin join, rcon save into /data/save', async () => {
    const { admin, welcome } = await connect();
    expect(welcome.mapX).toBe(1024); // map_x = 10
    const lines = await admin.rcon('save current');
    expect(lines.some((l) => l.includes('Map successfully saved'))).toBe(true);
    expect(existsSync(`${data}/save/current.sav`)).toBe(true);
    writeFileSync(`${data}/it-seed`, String(welcome.seed));
    admin.close();
  }, 30_000);

  it.runIf(phase === 'first' && !!process.env.GATEWAY_PORT)('WSS proxy reaches the real game port with a ticket', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signTicket(Buffer.from(process.env.TICKET_KEY!, 'hex'), {
      g: process.env.GAME_KEY!, s: 's-it', r: 'pupil', iat: now, exp: now + 120, n: `it-${now}-${Math.random()}`,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.GATEWAY_PORT}/g/${process.env.GAME_KEY}?t=${tok}`, 'binary');
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(Buffer.from([3, 0, 7])); // PacketGameType::ClientGameInfo
    const reply = await new Promise<Buffer>((r) => ws.on('message', (d) => r(d as Buffer)));
    expect(reply[2]).toBe(6); // PacketGameType::ServerGameInfo
    ws.close();
  }, 30_000);

  it.runIf(phase === 'restart')('a restart loads the same map from /data/save/current.sav', async () => {
    const { admin, welcome } = await connect();
    expect(String(welcome.seed)).toBe(readFileSync(`${data}/it-seed`, 'utf8'));
    admin.close();
  }, 30_000);
});
