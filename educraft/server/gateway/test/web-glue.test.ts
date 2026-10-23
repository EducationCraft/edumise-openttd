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

  it('accepts the direct per-class host but no other subdomain', () => {
    const direct = WSS.replace('wss://', 'wss://c3f0c9a1b2c4d.');
    expect(load('#w=' + encodeURIComponent(direct)).ctx.Module.websocket.url('doprava', 3979, 'tcp')).toBe(direct);
    for (const bad of ['wss://evil.ottd-server.edumise.educraft.cz', 'wss://c3f0c9a1b2c4d.ottd-server.edumise.educraft.cz.evil.example'])
      expect(load('#w=' + encodeURIComponent(WSS.replace('wss://ottd-server.edumise.educraft.cz', bad))).ctx.Module.websocket.url('doprava', 3979, 'tcp')).toBe('wss://');
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

  it('with #p=1 bridges the in-game wallet window to the parent and back', () => {
    const posted: any[] = [];
    const calls: any[] = [];
    const { ctx, parent, send } = load('#w=' + encodeURIComponent(WSS) + '&n=x&p=1');
    (parent as any).postMessage = (m: any, o: string) => posted.push([m, o]);
    ctx.Module.cwrap = (name: string) => (...a: any[]) => calls.push([name, ...a]);
    ctx.Module.eduWallet(0);
    ctx.Module.eduWallet(25);
    expect(posted).toEqual([
      [{ t: 'edumise-wallet-get' }, 'https://ottd.edumise.educraft.cz'],
      [{ t: 'edumise-deposit', amountTenths: 25 }, 'https://ottd.edumise.educraft.cz'],
    ]);
    const reply = { t: 'edumise-wallet', walletTenths: 98, hasCompany: true, deposit: true, message: 'ok' };
    send({ origin: 'https://evil.example', source: parent, data: reply });
    send({ origin: 'https://ottd.edumise.educraft.cz', source: {}, data: reply });
    send({ origin: 'https://ottd.edumise.educraft.cz', source: parent, data: { ...reply, walletTenths: '98' } });
    expect(calls).toEqual([]);
    send({ origin: 'https://ottd.edumise.educraft.cz', source: parent, data: reply });
    send({ origin: 'https://ottd.edumise.educraft.cz', source: parent, data: { t: 'edumise-wallet', walletTenths: -7, hasCompany: false, message: 'x'.repeat(400) } });
    expect(calls).toEqual([['em_openttd_edu_wallet', 98, 3, 'ok'], ['em_openttd_edu_wallet', -1, 0, 'x'.repeat(300)]]);
  });

  it('offers no wallet without #p=1 or outside a class game', () => {
    expect(load('#w=' + encodeURIComponent(WSS)).ctx.Module.eduWallet).toBeUndefined();
    expect(load('#p=1').ctx.Module.eduWallet).toBeUndefined();
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
    const listeners: ((e: any) => void)[] = [];
    const ctx: any = {
      window: { addEventListener: (_: string, f: any) => listeners.push(f) },
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
    /** A message from the game frame (or, with `source`, from somewhere else). */
    const fromGame = async (data: any, source = els.hra.contentWindow, origin = 'https://ottd.edumise.educraft.cz') => {
      listeners.forEach((f) => f({ origin, source, data }));
      await vi.advanceTimersByTimeAsync(0);
    };
    return { els, calls, tickets, fromGame };
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
    expect(labels(els)).toEqual(['45 minut', '1,5 hodiny', '2 hodiny', '3 hodiny', '4 hodiny', 'Zpět']);
    await click(els, '45 minut');
    expect(starts).toEqual([{ schoolId: S1, requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', action: 'start', minutes: 45 }]);
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
    expect(labels(els)).toEqual(['Hrát samostatně', 'Vstoupit jako starosta – 6.I', 'Prodloužit na 2 hodiny – 6.I', 'Ukončit hru – 6.I', '7.C – hra se ukončuje']);
    await click(els, 'Ukončit hru – 6.I');
    expect(stops).toEqual([]);
    await click(els, 'Ano, ukončit hru');
    expect(stops).toEqual([{ schoolId: S1, requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', action: 'stop' }]);
    expect(els.titulek.textContent).toBe('Hra se ukončuje.');
  });

  it('manager sees a countdown to stopDeadline, extends to 2 hours, and resumes a class at the limit', async () => {
    const posts: any[] = [];
    const skew = 600_000; // the wallet clock is 10 min ahead of this PC; the countdown follows the wallet
    let deadline = new Date(Date.now() + skew + 3_725_000).toISOString(); // 1:02:05
    let answer: { status: number; body: any } = { status: 200, body: { data: {} } };
    const { els } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN', name: 'ZŠ Demo' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [
        cls({ classId: K1, className: '6.I', session: 'limit', canManage: true, canMayor: true, stopDeadline: deadline }),
        cls({ classId: K2, className: '7.C', session: 'running', stopDeadline: deadline }),
      ], serverNow: new Date(Date.now() + skew).toISOString() } } }),
      [`POST /classes/${K1}/session`]: (body) => { posts.push(body); return answer; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels(els)).toEqual(['Hrát samostatně', 'Vstoupit jako starosta – 6.I', '6.I: Server se vypne za 1:02:05',
      'Prodloužit na 2 hodiny – 6.I', 'Pokračovat ve hře – 6.I', 'Ukončit hru – 6.I', 'Sledovat – 7.C']);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(labels(els)[2]).toBe('6.I: Server se vypne za 1:01:59');
    deadline = new Date(Date.now() + skew + 7_200_000).toISOString();
    await click(els, 'Prodloužit na 2 hodiny – 6.I');
    expect(posts).toEqual([{ schoolId: S1, requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', action: 'extend' }]);
    expect(labels(els)[2]).toBe('6.I: Server se vypne za 2:00:00');
    await click(els, 'Pokračovat ve hře – 6.I');
    expect(posts[1].action).toBe('resume');
    expect(els.chyba.hidden).toBe(true);
    answer = { status: 409, body: { error: 'invalid_state' } };
    await click(els, 'Pokračovat ve hře – 6.I');
    expect(els.chyba.textContent).toBe('Hra už nečeká na pokračování.');
    answer = { status: 403, body: { error: 'forbidden' } };
    await click(els, 'Prodloužit na 2 hodiny – 6.I');
    expect(els.chyba.textContent).toBe('Hru této třídy nemůžete prodloužit.');
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(labels(els)[2]).toBe('6.I: Server se vypíná.');
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

  it('a start that never reaches running times out after 15 minutes with a Czech error', async () => {
    const { els, tickets } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [cls({ classId: K1, className: '6.I', canManage: true })] } } }),
      [`POST /classes/${K1}/session`]: () => ({ status: 409, body: { error: 'invalid_state' } }),
      [`GET /classes/${K1}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { session: 'starting' } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await click(els, 'Spustit hru – 6.I');
    await click(els, '2 hodiny');
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 10_000);
    expect(tickets).toEqual([]);
    expect(els.chyba.textContent).toBe('Server se nespustil do 15 minut. Zkuste to prosím znovu.');
    expect(labels(els)).toEqual(['Zpět']);
  });

  it('start progress: ~55 s from a save, ~180 s for a reset world; 90 % at the estimate, never 100 %', async () => {
    const { els } = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN', name: 'ZŠ Demo' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [cls({ classId: K1, className: '6.I', canManage: true })] } } }),
      [`POST /classes/${K1}/session`]: () => ({ status: 200, body: { data: { session: 'starting' } } }),
      [`GET /classes/${K1}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { session: 'starting' } } }),
    });
    const progress = () => {
      const [bar, text] = els.tridy.children[0].children;
      return { value: Math.round(bar.value), text: text.textContent };
    };
    await vi.advanceTimersByTimeAsync(0);
    await click(els, 'Spustit hru – 6.I');
    await click(els, '45 minut');
    expect(els.zprava.textContent).toBe('Načítá se uložený svět.');
    expect(progress()).toEqual({ value: 0, text: '0 s z obvyklých ~55 s' });
    await vi.advanceTimersByTimeAsync(27_500);
    expect(progress()).toEqual({ value: 45, text: '28 s z obvyklých ~55 s' });
    await vi.advanceTimersByTimeAsync(27_500);
    expect(progress().value).toBe(90);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(progress().value).toBe(99); // 90 + 9·(1 − e^−t), rounded; the bar never reaches 100 by itself

    const r = load(jwt({ 'cognito:groups': ['TEACHER'] }), {
      'GET /my-schools': () => ({ status: 200, body: { data: { schools: [{ schoolId: S1, role: 'ADMIN', name: 'ZŠ Demo' }] } } }),
      [`GET /classes?schoolId=${S1}`]: () => ({ status: 200, body: { data: { classes: [cls({ classId: K2, className: '7.C', canManage: true, resetPending: true })] } } }),
      [`POST /classes/${K2}/session`]: () => ({ status: 200, body: { data: { session: 'starting' } } }),
      [`GET /classes/${K2}?schoolId=${S1}`]: () => ({ status: 200, body: { data: { session: 'starting' } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await click(r.els, 'Spustit hru – 7.C');
    await click(r.els, '45 minut');
    expect(r.els.zprava.textContent).toBe('Vytváří se nový svět, chvíli to potrvá.');
    const [bar, text] = r.els.tridy.children[0].children;
    expect(text.textContent).toBe('0 s z obvyklých ~180 s');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(Math.round(bar.value)).toBe(45);
    expect(text.textContent).toBe('90 s z obvyklých ~180 s');
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
    expect(labels(els)).toEqual(['Zpět na školy', 'Hrát samostatně', 'Vstoupit jako starosta – 6.I', 'Hrát za žáka – 6.I', 'Prodloužit na 2 hodiny – 6.I', 'Ukončit hru – 6.I']);
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

  describe('in-game wallet', () => {
    const pupilTicket = { status: 200, body: { data: { url: WSS, expiresAt: 'x', role: 'pupil', playerName: 'Tomáš N.' } } };
    const sessions = () => ({ status: 200, body: { data: { sessions: [{ classId: K1, className: '6.I', session: 'running', own: true }] } } });
    const me = (walletTenths: number, company: number | null = 2, session = 'running') =>
      () => ({ status: 200, body: { data: { walletTenths, game: { company, session } } } });
    const replies = (els: any) => els.hra.contentWindow.postMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.t === 'edumise-wallet');

    it('a pupil in their own class gets #p=1; the game reads the balance through the gate', async () => {
      const { els, fromGame } = load(jwt({ 'custom:student_id': 's-1' }), {
        'GET /me/sessions': sessions, 'POST /me/game-ticket': () => pupilTicket, 'GET /me': me(123, null),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS) + '&n=' + encodeURIComponent('Tomáš N.') + '&p=1');
      await fromGame({ t: 'edumise-wallet-get' });
      await fromGame({ t: 'edumise-wallet-get' }, {});
      await fromGame({ t: 'edumise-wallet-get' }, els.hra.contentWindow, 'https://evil.example');
      expect(replies(els)).toEqual([{ t: 'edumise-wallet', walletTenths: 123, hasCompany: false, deposit: false, message: '' }]);
      expect(els.hra.contentWindow.postMessage.mock.calls.at(-1)[1]).toBe('https://ottd.edumise.educraft.cz');
    });

    it('a deposit keeps its requestId over 503 and network errors and answers with the Kč amount', async () => {
      const bodies: any[] = [];
      let n = 0;
      const { els, fromGame } = load(jwt({ 'custom:student_id': 's-1' }), {
        'GET /me/sessions': sessions, 'POST /me/game-ticket': () => pupilTicket, 'GET /me': me(73),
        'POST /me/deposits': (b) => { bodies.push(b); return n++ === 0 ? { status: 503, body: { error: 'busy' } } : { status: 200, body: { data: { txId: 't', seq: 1, pounds: b.amountTenths * 150, state: 'reserved' } } }; },
      });
      await vi.advanceTimersByTimeAsync(0);
      await fromGame({ t: 'edumise-deposit', amountTenths: 50 });
      await fromGame({ t: 'edumise-deposit', amountTenths: 50 }); // second one while the first runs: dropped
      await vi.advanceTimersByTimeAsync(5000);
      expect(bodies).toEqual([
        { requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', amountTenths: 50 },
        { requestId: 'aaaaaaaa-2c4d-4e5f-8a9b-0c1d2e3f4a5b', amountTenths: 50 },
      ]);
      expect(replies(els)).toEqual([{ t: 'edumise-wallet', walletTenths: 73, hasCompany: true, deposit: true, message: 'Vklad 307 500 Kč odeslán, ve hře se objeví za chvilku.' }]);
    });

    it('a refused deposit answers with the Czech reason; bad amounts are ignored', async () => {
      const bodies: any[] = [];
      const { els, fromGame } = load(jwt({ 'custom:student_id': 's-1' }), {
        'GET /me/sessions': sessions, 'POST /me/game-ticket': () => pupilTicket, 'GET /me': me(5),
        'POST /me/deposits': (b) => { bodies.push(b); return { status: 409, body: { error: 'insufficient_funds' } }; },
      });
      await vi.advanceTimersByTimeAsync(0);
      await fromGame({ t: 'edumise-deposit', amountTenths: 0 });
      await fromGame({ t: 'edumise-deposit', amountTenths: 1.5 });
      await fromGame({ t: 'edumise-deposit', amountTenths: 10 });
      expect(bodies).toHaveLength(1);
      expect(replies(els)).toEqual([{ t: 'edumise-wallet', walletTenths: 5, hasCompany: true, deposit: true, message: 'Nemáš dost diamantů.' }]);
    });

    it('a pupil watching another class gets no wallet', async () => {
      const bodies: any[] = [];
      const { els, fromGame } = load(jwt({ 'custom:student_id': 's-1' }), {
        'GET /me/sessions': sessions, 'GET /me': me(100),
        'POST /me/game-ticket': () => ({ status: 200, body: { data: { url: WSS, expiresAt: 'x', role: 'spectator', playerName: 'Tomáš N.' } } }),
        'POST /me/deposits': (b) => { bodies.push(b); return { status: 200, body: { data: { pounds: 1 } } }; },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(els.hra.src).not.toContain('p=1');
      await fromGame({ t: 'edumise-deposit', amountTenths: 10 });
      expect(bodies).toEqual([]);
      expect(replies(els)).toEqual([]);
    });
  });
});
