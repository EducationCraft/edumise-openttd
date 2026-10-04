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

  it('passes #n (or "Hráč") as EDU_CLIENT_NAME in preRun so the join never has an empty name', () => {
    const run = (hash: string) => {
      const pre: (() => void)[] = [];
      const ctx: any = {
        location: { hash, protocol: 'https:', origin: 'https://ottd.edumise.educraft.cz' },
        window: { parent: {}, addEventListener() {} },
        Module: { arguments: [], preRun: pre },
        ENV: {},
      };
      vm.runInNewContext(readFileSync(join(ROOT, 'os/emscripten/pre.js'), 'utf8'), ctx);
      pre.forEach((f) => { try { f(); } catch { /* FS stubs missing */ } });
      return ctx.ENV.EDU_CLIENT_NAME;
    };
    expect(run('#w=' + encodeURIComponent(WSS) + '&n=' + encodeURIComponent('Tomáš N.'))).toBe('Tomáš N.');
    expect(run('#w=' + encodeURIComponent(WSS))).toBe('Hráč');
    expect(run('#w=' + encodeURIComponent(WSS) + '&n=%E0')).toBe('Hráč');
    expect(run('')).toBeUndefined();
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
      replaceChildren(...c: any[]) { this.children = c; },
      remove() {},
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
      escape, setInterval, clearInterval, setTimeout, encodeURIComponent,
      crypto: { randomUUID: () => 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b' }, decodeURIComponent, JSON, Object, Date, Error,
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
      'POST /me/game-ticket': () => ({ status: 200, body: { data: { url: WSS.replace('abc', `t${n++}`), expiresAt: 'x', playerName: n > 1 ? 'Jiný' : 'Tomáš N.' } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS.replace('abc', 't0')) + '&n=' + encodeURIComponent('Tomáš N.'));
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
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS) + '&n=' + encodeURIComponent('Hráč'));
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

  const cls = (o: any) => ({ pupils: 3, gameKey: 'g', session: 'stopped', canManage: false, canMayor: false, ...o });

  it('teacher with one school (from identity, even when the claim is an IČO): straight to its enrolled classes by session and role', async () => {
    const { els, calls, tickets } = load(jwt({ 'cognito:groups': ['TEACHER'], 'schools:12345678': 'TEACHER' }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'TEACHER', name: 'ZŠ Demo' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [
        cls({ classId: K1, className: '6.I', session: 'running', canMayor: true }),
        cls({ classId: K2, className: '7.C', session: 'limit' }),
        cls({ classId: P1, className: '8.B' }),
        cls({ classId: S2, className: '9.A', gameKey: null }),
      ] } } }),
      [`POST /classes/${K1}/game-ticket`]: (body) => (body.schoolId === S1 ? ok : { status: 403, body: {} }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.url.includes('/sessions'))).toHaveLength(0);
    expect(els.titulek.textContent).toBe('ZŠ Demo');
    expect(labels(els)).toEqual(['Hrát samostatně', 'Vstoupit jako starosta – 6.I', 'Sledovat – 7.C', '8.B – hra neběží']);
    await click(els, 'Vstoupit jako starosta – 6.I');
    expect(tickets).toEqual([{ schoolId: S1 }]);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS) + '&n=' + encodeURIComponent('Starosta'));
  });

  it('teacher without schools keeps single-player with a notice', async () => {
    const { els } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [] } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(els)).toEqual(['Hrát samostatně', 'Nejste učitelem žádné školy v Dopravě.']);
  });

  it('manager starts a stopped class, waits for running, then enters as mayor', async () => {
    let state = 'starting';
    const starts: any[] = [];
    const { els, tickets } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN', name: null }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [cls({ classId: K1, className: '6.I', canManage: true, canMayor: true })] } } }),
      [`POST /classes/${K1}/session`]: (body) => { starts.push(body); return { status: 200, body: { data: { session: 'starting', sessionId: 'x' } } }; },
      [`GET /classes/${K1}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { session: state } } }),
      [`POST /classes/${K1}/game-ticket`]: () => ok,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.titulek.textContent).toBe('Škola 3f0c9a1b');
    await click(els, 'Spustit hru – 6.I');
    expect(starts).toEqual([{ schoolId: S1, requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', action: 'start' }]);
    expect(els.titulek.textContent).toBe('Spouštím server třídy…');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickets).toEqual([]);
    state = 'running';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tickets).toEqual([{ schoolId: S1 }]);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS) + '&n=' + encodeURIComponent('Starosta'));
  });

  it('manager ends a running class after a confirmation; starting/stopping classes show their state', async () => {
    const stops: any[] = [];
    const { els } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN', name: 'ZŠ Demo' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [
        cls({ classId: K1, className: '6.I', session: 'running', canManage: true, canMayor: true }),
        cls({ classId: K2, className: '7.C', session: 'stopping', canManage: true }),
      ] } } }),
      [`POST /classes/${K1}/session`]: (body) => { stops.push(body); return { status: 200, body: { data: { session: 'stopping' } } }; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(els)).toEqual(['Hrát samostatně', 'Vstoupit jako starosta – 6.I', 'Ukončit hru – 6.I', '7.C – hra se ukončuje']);
    await click(els, 'Ukončit hru – 6.I');
    expect(stops).toEqual([]);
    await click(els, 'Ano, ukončit hru');
    expect(stops).toEqual([{ schoolId: S1, requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', action: 'stop' }]);
    expect(els.titulek.textContent).toBe('Hra se ukončuje.');
  });

  it('manager resets a stopped world after two steps and typing the class name; pending reset shows a label', async () => {
    const resets: any[] = [];
    let status = 403;
    const { els } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN', name: 'ZŠ Demo' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [
        cls({ classId: K1, className: '6.I', canManage: true }),
        cls({ classId: K2, className: '7.C', canManage: true, resetPending: true }),
        cls({ classId: P1, className: '8.B', resetPending: true }),
      ] } } }),
      [`POST /classes/${K1}/reset`]: (body) => { resets.push(body); return status === 200 ? { status, body: { data: {} } } : { status, body: { error: 'forbidden' } }; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(els)).toEqual(['Hrát samostatně', 'Spustit hru – 6.I', 'Resetovat svět – 6.I', 'Spustit hru – 7.C',
      '7.C – nový svět čeká na spuštění', '8.B – nový svět čeká na spuštění']);
    await click(els, 'Resetovat svět – 6.I');
    expect(els.zprava.textContent).toContain('žákům se vrátí vložené diamanty');
    await click(els, 'Pokračovat');
    const [pole, potvrd] = els.tridy.children;
    expect(potvrd.textContent).toBe('Resetovat svět');
    expect(potvrd.disabled).toBe(true);
    await click(els, 'Resetovat svět');
    expect(resets).toEqual([]);
    pole.value = '6.A';
    pole.listeners[0]();
    expect(potvrd.disabled).toBe(true);
    pole.value = ' 6.I ';
    pole.listeners[0]();
    expect(potvrd.disabled).toBe(false);
    await click(els, 'Resetovat svět');
    expect(resets).toEqual([{ schoolId: S1, requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b' }]);
    expect(els.chyba.textContent).toBe('Svět této třídy nemůžete resetovat.');
    expect(labels(els)).toEqual(['Zpět']);
    status = 200;
    await click(els, 'Zpět');
    await click(els, 'Resetovat svět – 6.I');
    await click(els, 'Pokračovat');
    els.tridy.children[0].value = '6.I';
    els.tridy.children[0].listeners[0]();
    await click(els, 'Resetovat svět');
    expect(els.titulek.textContent).toBe('Svět je resetován.');
  });

  it('a start that never reaches running times out after 4 minutes with a Czech error', async () => {
    const { els, tickets } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [cls({ classId: K1, className: '6.I', canManage: true })] } } }),
      [`POST /classes/${K1}/session`]: () => ({ status: 409, body: { error: 'invalid_state' } }),
      [`GET /classes/${K1}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { session: 'starting' } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await click(els, 'Spustit hru – 6.I');
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 10_000);
    expect(tickets).toEqual([]);
    expect(els.chyba.textContent).toBe('Server se nespustil do 4 minut. Zkuste to prosím znovu.');
    expect(labels(els)).toEqual(['Zpět']);
  });

  it('superadmin: school picker → class → "Hrát za žáka" → a concrete pupil', async () => {
    const { els, tickets } = load(jwt({ 'cognito:groups': ['superadmin'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [
        { schoolId: S2, role: 'SUPERADMIN', name: null },
        { schoolId: S1, role: 'SUPERADMIN', name: 'Demoškola' },
      ] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [cls({ classId: K1, className: '6.I', session: 'running', canManage: true, canMayor: true })] } } }),
      [`GET /classes/${K1}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { pupils: [{ studentId: P1, name: 'Tomáš N.', slot: 1 }] } } }),
      [`POST /classes/${K1}/game-ticket`]: () => ok,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(els)).toEqual(['Demoškola', 'Škola 4f0c9a1b']);
    await click(els, 'Demoškola');
    expect(labels(els)).toEqual(['Zpět na školy', 'Hrát samostatně', 'Vstoupit jako starosta – 6.I', 'Hrát za žáka – 6.I', 'Ukončit hru – 6.I']);
    await click(els, 'Zpět na školy');
    expect(labels(els)).toEqual(['Demoškola', 'Škola 4f0c9a1b']);
    await click(els, 'Demoškola');
    await click(els, 'Hrát za žáka – 6.I');
    expect(labels(els)).toEqual(['Tomáš N.']);
    await click(els, 'Tomáš N.');
    expect(tickets).toEqual([{ schoolId: S1, as: 'pupil', studentId: P1 }]);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS) + '&n=' + encodeURIComponent('Hráč'));
  });

  it('teacher deep link #s&c[&as=pupil&sid] requests that ticket directly', async () => {
    const { tickets } = load(jwt({ 'cognito:groups': ['superadmin'] }), { [`POST /classes/${K1}/game-ticket`]: () => ok }, `#s=${S1}&c=${K1}&as=pupil&sid=${P1}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(tickets).toEqual([{ schoolId: S1, as: 'pupil', studentId: P1 }]);
  });
});
