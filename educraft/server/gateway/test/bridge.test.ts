import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge, type Registry } from '../src/bridge';
import { FakeGs, FakeWallet, deposit } from './fakes';

let gs: FakeGs;
let w: FakeWallet;
let b: Bridge;
let dir: string;
let logs: { level: string; msg: string; extra?: any }[];
const registry: Registry = new Map();
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const results = (seq: number) => w.of('POST', `/ops/${seq}/result`).map((c) => c.body.status);
const seqs = (msgs: any[]) => msgs.map((m) => m.seq);
const range = (a: number, z: number) => Array.from({ length: z - a + 1 }, (_, i) => a + i);

beforeEach(async () => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  mkdirSync(join(dir, 'save'));
  mkdirSync(join(dir, 'snapshots'));
  gs = new FakeGs();
  w = new FakeWallet();
  logs = [];
  b = new Bridge(w, registry, dir, 'c000000000001', (level, msg, extra) => logs.push({ level, msg, extra }));
  gs.bridge = b;
  b.start();
});

afterEach(() => {
  b.stop();
  vi.useRealTimers();
});

describe('boot hello (§4.5 steps 1–4, §4.6)', () => {
  it('reports the GS state, starts the session and sends towns + finance', async () => {
    gs.last = 7;
    gs.ring = [[7, 1]];
    gs.co = [[0, 1]];
    await b.attach(gs);
    expect(w.of('POST', '/hello')[0].body).toEqual({ gsLastSeq: 7, ring: [[7, 1]], gsGame: 'c000000000001', bindings: [[0, 1]] });
    expect(gs.of('session')).toEqual([{ t: 'session', run: true, sid: 'sid-1', months: 18 }]);
    expect(w.of('PUT', '/towns')[0].body).toEqual({ towns: [{ id: 0, name: 'Citadela' }] });
    const fin = w.of('PUT', '/finance')[0].body;
    expect(fin.final).toBe(false);
    expect(fin.companies[0]).toMatchObject({ company: 0, cashPounds: 100, maxLoanPounds: 13924, valuePounds: 500, name: 'Rychlá doprava' });
    expect(b.phase).toBe('running');
  });

  it('refused hello keeps the game paused and retries every 60 s', async () => {
    w.setHello({}, 409, 'rollback_refused');
    await b.attach(gs);
    expect(b.phase).toBe('refused');
    await run(61_000);
    expect(w.of('POST', '/hello')).toHaveLength(2);
    expect(gs.of('session')).toEqual([]);
    expect(gs.of('op')).toEqual([]);
    expect(logs.some((l) => l.level === 'error' && l.extra?.error === 'rollback_refused')).toBe(true);
  });

  it('adopt anchors the map with a quiesced save before the session starts', async () => {
    gs.game = null;
    w.setHello({ adopt: true });
    await b.attach(gs);
    const i = (t: string) => gs.sent.findIndex((m) => m.t === t);
    expect(i('adopt')).toBeGreaterThan(-1);
    expect(i('adopt')).toBeLessThan(i('hold'));
    expect(i('hold')).toBeLessThan(i('session'));
    expect(gs.game).toBe('c000000000001');
    expect(gs.rcons).toContain('save current');
    expect(w.of('POST', '/saved')[0].body).toEqual({ lastSeq: 0, final: false });
    expect(readFileSync(join(dir, 'save', 'current.seq'), 'utf8')).toBe('0');
  });

  it('clears the bindings the wallet returns in unbind', async () => {
    gs.co = [[3, 2]];
    w.setHello({ unbind: [3] });
    await b.attach(gs);
    expect(gs.of('bind')).toEqual([{ t: 'bind', c: 3, s: null }]);
    expect(gs.co).toEqual([]);
  });
});

describe('op delivery (§4.5 step 5)', () => {
  it('keeps at most 16 ops in flight, unknown ones included', async () => {
    w.ops = range(1, 20).map((s) => deposit(s));
    gs.ignoreOps = true;
    await b.attach(gs);
    await run(2_000);
    expect(seqs(gs.of('op'))).toEqual(range(1, 16));
    await run(30_000);
    for (const s of range(1, 16)) expect(results(s)).toEqual(['unknown']);
    expect(new Set(seqs(gs.of('op')))).toEqual(new Set(range(1, 16)));
    expect(gs.of('op')).toHaveLength(32); // every in-flight op re-sent once, 17–20 still waiting
  });

  it('reports unknown after 30 s, re-sends, and resolves the op in the same session', async () => {
    w.ops = [deposit(1)];
    gs.dropFirst.set(1, 1);
    await b.attach(gs);
    await run(2_000);
    expect(results(1)).toEqual([]);
    await run(30_000);
    expect(results(1)).toEqual(['unknown', 'applied']);
    expect(gs.last).toBe(1);
  });

  it('delivers deposit fields and reports a failed ack with its reason', async () => {
    w.ops = [deposit(1), { seq: 2, kind: 'rename', slot: 1, company: 0, value: 'Rychlá doprava', noop: false }];
    gs.fail.set(2, 'name_taken');
    await b.attach(gs);
    await run(2_000);
    expect(gs.of('op')).toEqual([
      { t: 'op', seq: 1, k: 'deposit', s: 1, c: 0, p: 696 },
      { t: 'op', seq: 2, k: 'rename', s: 1, c: 0, v: 'Rychlá doprava' },
    ]);
    expect(w.of('POST', '/ops/2/result')[0].body).toEqual({ status: 'failed', reason: 'name_taken' });
  });

  it('mayor ops: tax/news/expand without slot/company, grant/fine with them; ack p goes to the result', async () => {
    w.ops = [
      { seq: 1, kind: 'grant', slot: 1, company: 0, pounds: 1000, noop: false },
      { seq: 2, kind: 'fine', slot: 1, company: 0, pounds: 500, noop: false },
      { seq: 3, kind: 'tax', slot: null, company: null, value: 25, noop: false },
      { seq: 4, kind: 'news', slot: null, company: null, value: 'Zítra se staví most.', noop: false },
      { seq: 5, kind: 'expand', slot: null, company: null, value: 12, houses: 5, noop: false },
    ];
    gs.ackP.set(1, 1000).set(2, 300).set(5, 3);
    gs.fail.set(4, 'invalid');
    await b.attach(gs);
    await run(2_000);
    expect(gs.of('op')).toEqual([
      { t: 'op', seq: 1, k: 'grant', s: 1, c: 0, p: 1000 },
      { t: 'op', seq: 2, k: 'fine', s: 1, c: 0, p: 500 },
      { t: 'op', seq: 3, k: 'tax', v: 25 },
      { t: 'op', seq: 4, k: 'news', v: 'Zítra se staví most.' },
      { t: 'op', seq: 5, k: 'expand', v: 12, p: 5 },
    ]);
    const body = (seq: number) => w.of('POST', `/ops/${seq}/result`)[0].body;
    expect([1, 2, 3, 4, 5].map(body)).toEqual([
      { status: 'applied', p: 1000 },
      { status: 'applied', p: 300 },
      { status: 'applied' },
      { status: 'failed', reason: 'invalid' },
      { status: 'applied', p: 3 },
    ]);
  });

  it('redelivers from the GS last after a rollback', async () => {
    gs.last = 5;
    gs.ring = [[5, 1]];
    w.ops = range(1, 8).map((s) => deposit(s));
    await b.attach(gs);
    await run(2_000);
    expect(w.of('GET', '/ops')[0].path).toBe('/ops?after=5&limit=16');
    expect(seqs(gs.of('op'))).toEqual([6, 7, 8]);
    for (const s of [6, 7, 8]) expect(results(s)).toEqual(['applied']);
  });

  it('sends a failed op as noop and reports nothing for it', async () => {
    w.ops = [deposit(1), deposit(2, { noop: true }), deposit(3)];
    await b.attach(gs);
    await run(2_000);
    expect(gs.of('op')[1]).toEqual({ t: 'op', seq: 2, k: 'noop' });
    expect(results(1)).toEqual(['applied']);
    expect(results(2)).toEqual([]);
    expect(results(3)).toEqual(['applied']);
  });

  it('treats 409 invalid_state as acked: no retry, no stall', async () => {
    w.ops = [deposit(1), deposit(2)];
    w.override.set('POST /ops/:n/result', (_b, path) =>
      path === '/ops/1/result' ? { status: 409, body: { error: 'invalid_state' } } : undefined,
    );
    await b.attach(gs);
    await run(60_000);
    expect(w.of('POST', '/ops/1/result')).toHaveLength(1);
    expect(results(2)).toEqual(['applied']);
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('invalid_state'))).toBe(true);
  });

  it('retries a result on 5xx with the same body', async () => {
    let n = 0;
    w.ops = [deposit(1)];
    w.override.set('POST /ops/:n/result', () => (n++ < 2 ? { status: 503, body: { error: 'busy' } } : undefined));
    await b.attach(gs);
    await run(10_000);
    expect(results(1)).toEqual(['applied', 'applied', 'applied']);
  });

  it('re-sends from expect on a gap nack', async () => {
    w.ops = [deposit(1), deposit(2)];
    gs.dropFirst.set(1, 1);
    await b.attach(gs);
    await run(2_000);
    expect(seqs(gs.of('op'))).toEqual([1, 2, 1, 2]);
    expect(results(1)).toEqual(['applied']);
    expect(results(2)).toEqual(['applied']);
  });

  it('holds ops nacked as paused and resumes the watchdog-paused GS', async () => {
    w.ops = [deposit(1)];
    await b.attach(gs);
    gs.run = false; // GS watchdog paused itself
    await run(2_000);
    expect(results(1)).toEqual([]);
    await run(10_000);
    expect(gs.of('session').at(-1)).toMatchObject({ run: true });
    expect(results(1)).toEqual(['applied']);
  });
});

describe('saves (§4.5 steps 8, 9, 12)', () => {
  it('saves every 5 minutes only after held', async () => {
    await b.attach(gs);
    gs.ignoreHold = true;
    await run(5 * 60_000 + 11_000);
    expect(gs.of('hold')).toHaveLength(1);
    expect(gs.rcons).not.toContain('save current');
    expect(w.of('POST', '/saved')).toEqual([]);
    expect(gs.of('session')).toHaveLength(2); // the hold was ended with session{run:true}
    gs.ignoreHold = false;
    gs.last = 4;
    await run(5 * 60_000);
    expect(gs.rcons).toContain('save current');
    expect(w.of('POST', '/saved')[0].body).toEqual({ lastSeq: 4, final: false });
    expect(readFileSync(join(dir, 'save', 'current.seq'), 'utf8')).toBe('4');
  });

  it('does not report a save that rcon did not confirm', async () => {
    await b.attach(gs);
    gs.saveOk = false;
    await run(5 * 60_000 + 1_000);
    expect(gs.rcons).toContain('save current');
    expect(w.of('POST', '/saved')).toEqual([]);
  });

  it('limit: saves, keeps the game paused and stops the session after 10 minutes', async () => {
    await b.attach(gs);
    const runs = gs.of('session').length;
    b.onGs(JSON.stringify({ t: 'limit', months: 18 }));
    await run(1_000);
    expect(gs.rcons.filter((c) => c === 'save current')).toHaveLength(1);
    expect(gs.sent.at(-1)).toEqual({ t: 'hello', v: 1 });
    await run(10 * 60_000);
    expect(gs.of('session')).toHaveLength(runs);
    expect(w.of('POST', '/session').map((c) => c.body)).toEqual([{ action: 'stop', reason: 'limit' }]);
    expect(gs.rcons.filter((c) => c === 'save current')).toHaveLength(1);
  });

  it('SIGTERM with held: final finance, save, snapshot, saved{final}', async () => {
    await b.attach(gs);
    gs.last = 9;
    writeFileSync(join(dir, 'save', 'current.sav'), 'map');
    const done = b.shutdown();
    await run(1_000);
    await done;
    const i = (t: string) => gs.sent.findIndex((m) => m.t === t && !(t === 'session' && m.run));
    expect(i('session')).toBeLessThan(i('hold'));
    expect(w.of('PUT', '/finance').at(-1)!.body.final).toBe(true);
    expect(gs.rcons.at(-1)).toBe('save current');
    const snaps = readdirSync(join(dir, 'snapshots')).sort();
    expect(snaps).toHaveLength(2);
    expect(readFileSync(join(dir, 'snapshots', snaps.find((f) => f.endsWith('.seq'))!), 'utf8')).toBe('9');
    expect(w.of('POST', '/saved').at(-1)!.body).toEqual({ lastSeq: 9, final: true });
  });

  it('SIGTERM delivers pending op results before saved{final}', async () => {
    let n = 0;
    w.ops = [deposit(1)];
    w.override.set('POST /ops/:n/result', () => (n++ < 1 ? { status: 503, body: { error: 'busy' } } : undefined));
    await b.attach(gs);
    await run(2_000);
    writeFileSync(join(dir, 'save', 'current.sav'), 'map');
    const done = b.shutdown();
    await run(5_000);
    await done;
    const order = w.calls.map((c) => `${c.method} ${c.path}`).filter((c) => c.startsWith('POST /ops/1') || c.startsWith('POST /saved'));
    expect(order).toEqual(['POST /ops/1/result', 'POST /ops/1/result', 'POST /saved']);
    expect(w.of('POST', '/saved')[0].body).toEqual({ lastSeq: 1, final: true });
  });

  it('SIGTERM retries the final finance on 5xx, then reports saved{final}', async () => {
    await b.attach(gs);
    let n = 0;
    w.override.set('PUT /finance', (body) => (body.final && n++ < 2 ? { status: 503, body: { error: 'busy' } } : undefined));
    writeFileSync(join(dir, 'save', 'current.sav'), 'map');
    const done = b.shutdown();
    await run(10_000);
    await done;
    expect(w.of('PUT', '/finance').filter((c) => c.body.final)).toHaveLength(3);
    expect(w.of('POST', '/saved').at(-1)!.body).toMatchObject({ final: true });
  });

  it('SIGTERM without final finance saves, but never reports the session final', async () => {
    await b.attach(gs);
    gs.last = 3;
    w.override.set('PUT /finance', (body) => (body.final ? { status: 503, body: { error: 'busy' } } : undefined));
    writeFileSync(join(dir, 'save', 'current.sav'), 'map');
    const done = b.shutdown();
    await run(60_000);
    await done;
    expect(w.of('PUT', '/finance').filter((c) => c.body.final)).toHaveLength(5);
    expect(gs.rcons.at(-1)).toBe('save current');
    expect(w.of('POST', '/saved').map((c) => c.body)).toEqual([{ lastSeq: 3, final: false }]);
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('final finance not delivered'))).toBe(true);
  });

  it('a failing background save is logged, not an unhandled rejection', async () => {
    await b.attach(gs);
    rmSync(join(dir, 'save'), { recursive: true }); // current.seq cannot be written
    b.onGs(JSON.stringify({ t: 'limit', months: 18 }));
    await run(1_000);
    expect(logs.some((l) => l.level === 'error' && l.msg === 'save failed')).toBe(true);
    expect(b.saving).toBe(false);
  });

  it('SIGTERM without held skips the final save', async () => {
    await b.attach(gs);
    gs.ignoreHold = true;
    const done = b.shutdown();
    await run(11_000);
    await done;
    expect(gs.rcons).not.toContain('save current');
    expect(w.of('POST', '/saved')).toEqual([]);
    expect(w.of('PUT', '/finance').some((c) => c.body.final)).toBe(false);
  });
});

describe('failure modes (§4.5 steps 10, 11)', () => {
  it('GS dead: rcon pause, gs_dead stop, never saves again', async () => {
    await b.attach(gs);
    gs.alive = false;
    await run(41_000);
    expect(gs.rcons).toContain('pause');
    expect(w.of('POST', '/session').map((c) => c.body)).toEqual([{ action: 'stop', reason: 'gs_dead' }]);
    await run(10 * 60_000);
    expect(gs.rcons).not.toContain('save current');
    await b.shutdown();
    expect(gs.rcons).not.toContain('save current');
  });

  it('wallet unreachable for 60 s pauses the session; a reachable wallet re-runs hello', async () => {
    await b.attach(gs);
    w.down = true;
    await run(65_000);
    expect(gs.of('session').at(-1)).toEqual({ t: 'session', run: false });
    expect(b.phase).toBe('offline');
    w.down = false;
    await run(6_000);
    expect(w.of('POST', '/hello').length).toBe(2);
    expect(gs.of('session').at(-1)).toMatchObject({ run: true, sid: 'sid-1' });
    expect(b.phase).toBe('running');
  });
});

describe('GS reports', () => {
  it('forwards need as a rescue, gone companies, and monthly finance', async () => {
    await b.attach(gs);
    b.onGs(JSON.stringify({ t: 'need', c: 0, cash: -2500, loan: 13924, ml: 13924, p: 3500 }));
    b.onGs(JSON.stringify({ t: 'company', c: 0, ev: 'removed' }));
    b.onGs(JSON.stringify({ t: 'fin', pg: 0, pgs: 1, d: '1951-04-01', co: gs.fin }));
    b.onGs(JSON.stringify({ t: 'names', pg: 0, pgs: 1, co: [[0, 'X']] }));
    await run(0);
    expect(w.of('POST', '/rescues')[0].body).toEqual({ company: 0, pounds: 3500 });
    expect(w.of('POST', '/companies/0/gone')[0].body).toEqual({ reason: 'removed' });
    expect(b.slots.get(1)!.company).toBeNull();
    expect(w.of('PUT', '/finance').at(-1)!.body).toMatchObject({ gameDate: '1951-04-01', final: false });
  });

  it('forwards the treasury (fin page 0 pokl) as treasuryPounds, monthly and on report', async () => {
    gs.pokl = 20000;
    await b.attach(gs);
    expect(w.of('PUT', '/finance')[0].body.treasuryPounds).toBe(20000);
    b.onGs(JSON.stringify({ t: 'fin', pg: 0, pgs: 2, d: '1951-04-01', pokl: 23456, co: gs.fin }));
    b.onGs(JSON.stringify({ t: 'fin', pg: 1, pgs: 2, d: '1951-04-01', co: [] }));
    b.onGs(JSON.stringify({ t: 'names', pg: 0, pgs: 1, co: [[0, 'X']] }));
    await run(0);
    expect(w.of('PUT', '/finance').at(-1)!.body).toMatchObject({ gameDate: '1951-04-01', treasuryPounds: 23456 });
  });
});

describe('admission (§6.3)', () => {
  beforeEach(async () => {
    registry.clear();
    registry.set('127.77.0.1', { studentId: 's-1', role: 'pupil' });
    registry.set('127.77.0.2', { studentId: 's-2', role: 'pupil' });
    registry.set('127.77.0.3', { studentId: null, role: 'spectator' });
    registry.set('127.77.0.4', { studentId: 's-9', role: 'pupil' });
    registry.set('127.77.0.5', { studentId: null, role: 'mayor' });
    await b.attach(gs);
  });

  it('decides from CLIENT_INFO: kick, spectator, own company, new, not in a slot', async () => {
    b.onClientInfo(1, ''); // the server itself
    b.onClientInfo(5, '10.0.0.9');
    b.onClientInfo(6, '127.77.0.3');
    b.onClientInfo(7, '127.77.0.1');
    b.onClientInfo(8, '127.77.0.2');
    b.onClientInfo(9, '127.77.0.4');
    await run(0);
    // Admissions run concurrently (each awaits its own GET /slots): compare as a set.
    expect([...gs.rcons].sort()).toEqual([
      'kick 5',
      'edu_admit 6 spectator',
      'edu_admit 7 1',
      'edu_admit 8 new',
      'say_client 8 "Založ si svou firmu: Seznam hráčů → Nová firma."',
      'edu_admit 9 spectator',
      'say_client 9 "Nejsi v žádném týmu – požádej učitele o zařazení."',
    ].sort());
    expect(gs.rcons.indexOf('edu_admit 8 new')).toBeLessThan(gs.rcons.indexOf('say_client 8 "Založ si svou firmu: Seznam hráčů → Nová firma."'));
    expect(w.of('GET', '/slots')).toHaveLength(3); // every pupil admission reads a fresh map (D20)
  });

  it('a mayor never gets a company: spectator + chat, no slot lookup', async () => {
    b.onClientInfo(10, '127.77.0.5');
    await run(0);
    expect(gs.rcons).toEqual(['edu_admit 10 spectator', 'say_client 10 "Jsi starosta. Ovládání: EduMise → Učitel → Starosta."']);
    expect(w.of('GET', '/slots')).toHaveLength(0);
  });

  it('pupil admission uses the fresh map: a pupil moved to another team joins its company', async () => {
    w.slots = [{ slot: 1, company: 0, studentIds: ['s-1', 's-2'] }];
    b.onClientInfo(8, '127.77.0.2');
    await run(0);
    expect(gs.rcons).toEqual(['edu_admit 8 1']);
  });

  it('slotsRev change: moved pupils are demoted with a chat, the others stay', async () => {
    let rev = 0;
    w.override.set('GET /ops', () => ({ status: 200, body: { data: { ops: [], session: 'running', slotsRev: rev } } }));
    b.onClientInfo(7, '127.77.0.1'); // s-1 → company 0
    b.onClientInfo(8, '127.77.0.2'); // s-2 → new in slot 2
    b.onClientInfo(10, '127.77.0.5'); // mayor
    await run(2_000);
    const before = gs.rcons.length;
    expect(gs.rcons.slice(before)).toEqual([]);
    // s-1 moves to slot 2 (no company), slot 1 keeps its company without members.
    w.slots = [{ slot: 1, company: 0, studentIds: [] }, { slot: 2, company: null, studentIds: ['s-2', 's-1'] }];
    rev = 1;
    await run(2_000);
    expect(gs.rcons.slice(before)).toEqual(['edu_admit 7 spectator', 'say_client 7 "Tvůj tým se změnil – připoj se znovu."']);
    expect(b.slots.get(2)!.studentIds).toEqual(['s-2', 's-1']);
    await run(2_000); // same rev: nothing more
    expect(gs.rcons.length).toBe(before + 2);
  });

  it('slotsRev change with a failed GET /slots is retried on the next poll', async () => {
    let rev = 0;
    let slotsDown = false;
    w.override.set('GET /ops', () => ({ status: 200, body: { data: { ops: [], session: 'running', slotsRev: rev } } }));
    w.override.set('GET /slots', () => (slotsDown ? { status: 503, body: {} } : undefined));
    b.onClientInfo(7, '127.77.0.1'); // s-1 → company 0
    await run(2_000);
    const before = gs.rcons.length;
    w.slots = [{ slot: 1, company: 0, studentIds: [] }, { slot: 2, company: null, studentIds: ['s-2', 's-1'] }];
    rev = 1;
    slotsDown = true;
    await run(2_000);
    expect(gs.rcons.slice(before)).toEqual([]);
    expect(b.slotsRev).toBe(0);
    slotsDown = false;
    await run(2_000);
    expect(gs.rcons.slice(before)).toEqual(['edu_admit 7 spectator', 'say_client 7 "Tvůj tým se změnil – připoj se znovu."']);
    expect(b.slotsRev).toBe(1);
  });

  it('slotsRev change: a teamless spectator pupil now in a team is told to reconnect, once', async () => {
    let rev = 0;
    w.override.set('GET /ops', () => ({ status: 200, body: { data: { ops: [], session: 'running', slotsRev: rev } } }));
    b.onClientInfo(9, '127.77.0.4'); // s-9 → no team
    await run(2_000);
    const before = gs.rcons.length;
    w.slots = [...w.slots, { slot: 3, company: null, studentIds: ['s-9'] }];
    rev = 1;
    await run(2_000);
    expect(gs.rcons.slice(before)).toEqual(['say_client 9 "Tvůj tým se změnil – připoj se znovu."']);
    rev = 2;
    await run(2_000);
    expect(gs.rcons.length).toBe(before + 1);
  });

  it('not_member on founding: spectator, reset the company, chat', async () => {
    w.override.set('POST /companies', () => ({ status: 409, body: { error: 'not_member' } }));
    b.onClientInfo(8, '127.77.0.2');
    await run(0);
    b.onClientUpdate(8, 4);
    await run(1_000);
    expect(w.of('POST', '/companies')[0].body.studentId).toBe('s-2');
    expect(gs.rcons.slice(-3)).toEqual(['edu_admit 8 spectator', 'reset_company 5', 'say_client 8 "Tvůj tým se změnil – připoj se znovu."']);
    expect(gs.of('bind')).toEqual([]);
  });

  it('maps client_id → ip only from CLIENT_INFO', async () => {
    b.onClientUpdate(42, 3);
    await run(0);
    expect(w.of('POST', '/companies')).toEqual([]);
  });

  it('binds a founded company, saves, and admits the pupil to it', async () => {
    b.onClientInfo(8, '127.77.0.2');
    b.onCompanyInfo(4, 'Nová firma s.r.o.');
    await run(0);
    b.onClientUpdate(8, 4);
    await run(1_000);
    expect(w.of('POST', '/companies')[0].body).toEqual({ slot: 2, company: 4, companyName: 'Nová firma s.r.o.', studentId: 's-2' });
    expect(gs.of('bind')).toEqual([{ t: 'bind', c: 4, s: 2 }]);
    expect(gs.rcons).toContain('save current');
    expect(gs.rcons.at(-1)).toBe('edu_admit 8 5');
  });

  it('already_bound: joins the bound company and resets the extra one', async () => {
    w.override.set('POST /companies', () => ({ status: 409, body: { error: 'already_bound', company: 6 } }));
    b.onClientInfo(8, '127.77.0.2');
    await run(0);
    b.onClientUpdate(8, 4);
    await run(1_000);
    expect(gs.rcons.slice(-2)).toEqual(['edu_admit 8 7', 'reset_company 5']);
  });

  it('already_bound to the same company (a retried POST that committed): binds, saves, admits', async () => {
    w.override.set('POST /companies', () => ({ status: 409, body: { error: 'already_bound', company: 4 } }));
    b.onClientInfo(8, '127.77.0.2');
    await run(0);
    b.onClientUpdate(8, 4);
    await run(1_000);
    expect(gs.of('bind')).toEqual([{ t: 'bind', c: 4, s: 2 }]);
    expect(gs.rcons).toContain('save current');
    expect(gs.rcons).not.toContain('reset_company 5');
    expect(gs.rcons.at(-1)).toBe('edu_admit 8 5');
  });

  it('CLIENT_INFO poll after a reconnect binds a pupil who founded while the link was down', async () => {
    b.onClientInfo(8, '127.77.0.2');
    await run(0);
    const admits = gs.rcons.length;
    b.onClientInfo(8, '127.77.0.2', 255); // still a spectator: nothing to do
    await run(0);
    expect(gs.rcons).toHaveLength(admits);
    b.onClientInfo(8, '127.77.0.2', 4);
    await run(1_000);
    expect(w.of('POST', '/companies')[0].body).toMatchObject({ slot: 2, company: 4 });
    expect(gs.of('bind')).toEqual([{ t: 'bind', c: 4, s: 2 }]);
    b.onClientInfo(7, '127.77.0.1', 0);
    b.onClientInfo(7, '127.77.0.1', 0);
    await run(0);
    expect(gs.rcons.filter((c) => c === 'edu_admit 7 1')).toHaveLength(1);
  });

  it('company_taken: re-runs hello, retries once, then spectator + reset', async () => {
    w.override.set('POST /companies', () => ({ status: 409, body: { error: 'company_taken' } }));
    b.onClientInfo(8, '127.77.0.2');
    await run(0);
    const hellos = w.of('POST', '/hello').length;
    b.onClientUpdate(8, 4);
    await run(1_000);
    expect(w.of('POST', '/hello').length).toBe(hellos + 1);
    expect(w.of('POST', '/companies')).toHaveLength(2);
    expect(gs.rcons.slice(-2)).toEqual(['edu_admit 8 spectator', 'reset_company 5']);
    expect(logs.some((l) => l.level === 'error' && l.extra?.error === 'company_taken')).toBe(true);
  });
});
