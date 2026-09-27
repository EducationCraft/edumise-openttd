/**
 * Runs only against a live dedicated server (the image of ../Dockerfile), e.g.
 *   OPENTTD_ADMIN_SECRET=<hex> OPENTTD_DATA=<host dir mounted at /data> npx vitest run test/real-server.test.ts
 * Proves the admin handshake/encryption against real OpenTTD and that "save current"
 * lands in /data/save (contract §4.5 step 8, §6.2).
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AdminClient } from '../src/admin';

const secret = process.env.OPENTTD_ADMIN_SECRET;
const noop = () => {};

describe.skipIf(!secret)('real OpenTTD admin port', () => {
  it('joins with the authorized key, runs rcon and saves into /data/save', async () => {
    const companies: number[] = [];
    const admin = new AdminClient(Uint8Array.from(Buffer.from(secret!, 'hex')), {
      gs: noop, clientInfo: noop, clientUpdate: noop, clientQuit: noop, companyNew: noop,
      companyInfo: (c) => companies.push(c), companyRemove: noop, closed: noop,
    });
    await admin.connect('127.0.0.1', Number(process.env.OPENTTD_ADMIN_PORT ?? 3977));
    const lines = await admin.rcon('save current');
    expect(lines.some((l) => l.includes('Map successfully saved'))).toBe(true);
    if (process.env.OPENTTD_DATA) expect(existsSync(`${process.env.OPENTTD_DATA}/save/current.sav`)).toBe(true);
    const again = await admin.rcon('clients');
    expect(Array.isArray(again)).toBe(true);
    admin.close();
  }, 30_000);
});
