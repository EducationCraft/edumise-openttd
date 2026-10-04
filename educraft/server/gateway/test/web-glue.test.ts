/**
 * The browser side of §6.4: educraft/brana.js (gate) and os/emscripten/pre.js (WASM URL),
 * run in a vm with just enough DOM stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const WSS = 'wss://ottd-server.edumise.educraft.cz/g/c3f0c9a1b2c4d?t=abc.def';

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.s`;

describe('pre.js', () => {
  function load(hash: string) {
    const listeners: ((e: any) => void)[] = [];
    const parent = {};
    const ctx: any = {
      location: { hash, protocol: 'https:', origin: 'https://ottd.edumise.educraft.cz' },
      window: { parent, addEventListener: (_: string, f: any) => listeners.push(f) },
      Module: { arguments: [], preRun: { push() {} } },
    };
    vm.runInNewContext(readFileSync(join(ROOT, 'os/emscripten/pre.js'), 'utf8'), ctx);
    return { ctx, parent, send: (e: any) => listeners.forEach((f) => f(e)) };
  }

  it('without #w keeps single-player and today\'s WebSocket rules', () => {
    const { ctx } = load('');
    expect(ctx.Module.arguments).toEqual(['-mnull', '-snull', '-vsdl']);
    expect(ctx.Module.websocket.url('content.openttd.org', 3978, 'tcp')).toBe('wss://bananas-server.openttd.org/');
    expect(ctx.Module.websocket.url('doprava', 3979, 'tcp')).toBe('wss://');
  });

  it('joins doprava as spectator and always uses the newest ticket from the parent', () => {
    const { ctx, parent, send } = load('#w=' + encodeURIComponent(WSS));
    expect(ctx.Module.arguments.slice(-2)).toEqual(['-n', 'doprava:3979#255']);
    expect(ctx.Module.websocket.url('doprava', 3979, 'tcp')).toBe(WSS);
    const next = WSS.replace('abc.def', 'new.one');
    send({ origin: 'https://evil.example', source: parent, data: { t: 'edumise-ticket', url: next } });
    send({ origin: 'https://ottd.edumise.educraft.cz', source: {}, data: { t: 'edumise-ticket', url: next } });
    send({ origin: 'https://ottd.edumise.educraft.cz', source: parent, data: { t: 'edumise-ticket', url: 'wss://evil.example/g/c3f0c9a1b2c4d?t=x' } });
    expect(ctx.Module.websocket.url('doprava', 3979, 'tcp')).toBe(WSS);
    send({ origin: 'https://ottd.edumise.educraft.cz', source: parent, data: { t: 'edumise-ticket', url: next } });
    expect(ctx.Module.websocket.url('doprava', 3979, 'tcp')).toBe(next);
  });

  it('ignores a #w pointing anywhere else', () => {
    const { ctx } = load('#w=' + encodeURIComponent('wss://evil.example/g/c3f0c9a1b2c4d?t=x'));
    expect(ctx.Module.arguments).not.toContain('-n');
  });
});

describe('brana.js', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function el() {
    return {
      textContent: '', hidden: true, href: '', src: '', children: [] as any[],
      appendChild(c: any) { this.children.push(c); },
      replaceChildren() { this.children = []; },
      contentWindow: { postMessage: vi.fn() },
    };
  }

  function load(idToken: string, routes: Record<string, (body: any) => { status: number; body: any }>, hash = '') {
    const els: Record<string, any> = { titulek: el(), zprava: el(), chyba: el(), odkaz: el(), tridy: el(), hra: el() };
    const calls: { url: string; init: any }[] = [];
    const tickets: any[] = [];
    const ctx: any = {
      location: { origin: 'https://ottd.edumise.educraft.cz', hash },
      document: {
        getElementById: (id: string) => els[id],
        body: { classList: { add: vi.fn() } },
        createElement: () => ({ ...el(), listeners: [] as any[], addEventListener(_: string, f: any) { this.listeners.push(f); } }),
      },
      fetch: async (url: string, init: any) => {
        calls.push({ url, init });
        if (url.endsWith('/auth/refresh')) return { ok: true, status: 200, json: async () => ({ idToken }) };
        const key = `${init.method} ${url.replace('https://api.educraft.cz/wallet', '')}`;
        const r = routes[key]?.(init.body && JSON.parse(init.body)) ?? { status: 404, body: { error: 'not_found' } };
        tickets.push(...(key.endsWith('/game-ticket') ? [JSON.parse(init.body)] : []));
        return { ok: r.status === 200, status: r.status, json: async () => r.body };
      },
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      escape, setInterval, encodeURIComponent, decodeURIComponent, JSON, Object, Date, Error,
    };
    vm.runInNewContext(readFileSync(join(ROOT, 'educraft/brana.js'), 'utf8'), ctx);
    return { els, calls, tickets };
  }

  const S1 = '3f0c9a1b-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const S2 = '4f0c9a1b-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const K1 = '11111111-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const K2 = '22222222-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const P1 = '33333333-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const ok = { status: 200, body: { data: { url: WSS, expiresAt: 'x' } } };
  const labels = (els: any) => els.tridy.children.map((b: any) => b.textContent);
  const click = async (els: any, text: string) => {
    els.tridy.children.find((b: any) => b.textContent === text).listeners[0]();
    await vi.advanceTimersByTimeAsync(0);
  };

  it('pupil: only the own class runs → joins at once, then a fresh ticket by postMessage every 90 s', async () => {
    let n = 0;
    const { els, calls, tickets } = load(jwt({ 'custom:student_id': 's-1' }), {
      'GET /me/sessions': () => ({ status: 200, body: { data: { sessions: [{ classId: K1, className: '6.I', session: 'running', own: true }] } } }),
      'POST /me/game-ticket': () => ({ status: 200, body: { data: { url: WSS.replace('abc', `t${n++}`), expiresAt: 'x' } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS.replace('abc', 't0')));
    expect(calls.find((c) => c.url.endsWith('/me/game-ticket'))!.init.headers.Authorization).toMatch(/^Bearer h\./);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(els.hra.contentWindow.postMessage).toHaveBeenCalledWith({ t: 'edumise-ticket', url: WSS.replace('abc', 't1') }, 'https://ottd.edumise.educraft.cz');
    expect(tickets).toEqual([{ classId: K1 }, { classId: K1 }]); // the same body every refresh
  });

  it('pupil: several classes run → "Hrát" for the own one, "Dívat se" for the others', async () => {
    const { els, tickets } = load(jwt({ 'custom:student_id': 's-1' }), {
      'GET /me/sessions': () => ({ status: 200, body: { data: { sessions: [
        { classId: K1, className: '6.I', session: 'running', own: true },
        { classId: K2, className: '7.C', session: 'limit', own: false },
      ] } } }),
      'POST /me/game-ticket': () => ok,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.hra.src).toBe('');
    expect(labels(els)).toEqual(['Hrát – 6.I', 'Dívat se – 7.C']);
    await click(els, 'Dívat se – 7.C');
    expect(tickets).toEqual([{ classId: K2 }]);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS));
  });

  it('pupil without a running session sees the Czech notice', async () => {
    const { els } = load(jwt({ 'custom:student_id': 's-1' }), {
      'GET /me/sessions': () => ({ status: 200, body: { data: { sessions: [] } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.titulek.textContent).toBe('Hodina Dopravy teď neběží.');
    expect(els.hra.src).toBe('');
  });

  it('pupil deep link #c joins that class; a non-UUID is ignored', async () => {
    const a = load(jwt({ 'custom:student_id': 's-1' }), { 'POST /me/game-ticket': () => ok }, `#c=${K2}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.tickets).toEqual([{ classId: K2 }]);
    const b = load(jwt({ 'custom:student_id': 's-1' }), { 'GET /me/sessions': () => ({ status: 200, body: { data: { sessions: [] } } }) }, '#c=../x');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.tickets).toEqual([]);
  });

  it('a malformed deep link (#c=%E0) is ignored and the class list still loads', async () => {
    const { els, tickets } = load(jwt({ 'custom:student_id': 's-1' }), {
      'GET /me/sessions': () => ({ status: 200, body: { data: { sessions: [] } } }),
    }, '#c=%E0');
    await vi.advanceTimersByTimeAsync(0);
    expect(tickets).toEqual([]);
    expect(els.titulek.textContent).toBe('Hodina Dopravy teď neběží.');
  });

  it('teacher: single-player plus mayor / spectator buttons from /sessions (schools from identity, even when the claim is an IČO)', async () => {
    const { els, calls, tickets } = load(jwt({ 'cognito:groups': ['TEACHER'], 'schools:12345678': 'TEACHER' }), {
      'GET /sessions': () => ({ status: 200, body: { data: { sessions: [
        { schoolId: S1, classId: K1, className: '6.I', session: 'running', role: 'mayor', canPlayAsPupil: false },
        { schoolId: S1, classId: K2, className: '7.C', session: 'running', role: 'spectator', canPlayAsPupil: false },
      ] } } }),
      [`POST /classes/${K1}/game-ticket`]: (body) => (body.schoolId === S1 ? ok : { status: 403, body: {} }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.url.includes('/sessions'))).toHaveLength(1);
    expect(labels(els)).toEqual(['Hrát samostatně', 'Vstoupit jako starosta – 6.I', 'Sledovat – 7.C']);
    await click(els, 'Vstoupit jako starosta – 6.I');
    expect(tickets).toEqual([{ schoolId: S1 }]);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS));
  });

  it('superadmin: school → class → "Hrát za žáka" → a concrete pupil', async () => {
    const { els, tickets } = load(jwt({ 'cognito:groups': ['superadmin'] }), {
      'GET /sessions': () => ({ status: 200, body: { data: { sessions: [
        { schoolId: S1, classId: K1, className: '6.I', session: 'running', role: 'mayor', canPlayAsPupil: true },
        { schoolId: S2, classId: K2, className: '8.A', session: 'running', role: 'mayor', canPlayAsPupil: true },
      ] } } }),
      [`GET /classes/${K1}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { pupils: [{ studentId: P1, name: 'Tomáš N.', slot: 1 }] } } }),
      [`POST /classes/${K1}/game-ticket`]: () => ok,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(els)).toEqual(['Hrát samostatně', 'Škola 3f0c9a1b (6.I)', 'Škola 4f0c9a1b (8.A)']);
    await click(els, 'Škola 3f0c9a1b (6.I)');
    expect(labels(els)).toEqual(['Vstoupit jako starosta – 6.I', 'Hrát za žáka – 6.I']);
    await click(els, 'Hrát za žáka – 6.I');
    expect(labels(els)).toEqual(['Tomáš N.']);
    await click(els, 'Tomáš N.');
    expect(tickets).toEqual([{ schoolId: S1, as: 'pupil', studentId: P1 }]);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS));
  });

  it('teacher deep link #s&c[&as=pupil&sid] requests that ticket directly', async () => {
    const { tickets } = load(jwt({ 'cognito:groups': ['superadmin'] }), { [`POST /classes/${K1}/game-ticket`]: () => ok }, `#s=${S1}&c=${K1}&as=pupil&sid=${P1}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(tickets).toEqual([{ schoolId: S1, as: 'pupil', studentId: P1 }]);
  });
});
