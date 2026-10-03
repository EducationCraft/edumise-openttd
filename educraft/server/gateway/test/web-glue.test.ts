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
    return { textContent: '', hidden: true, href: '', src: '', children: [] as any[], appendChild(c: any) { this.children.push(c); }, contentWindow: { postMessage: vi.fn() } };
  }

  function load(idToken: string, routes: Record<string, (body: any) => { status: number; body: any }>) {
    const els: Record<string, any> = { titulek: el(), zprava: el(), chyba: el(), odkaz: el(), tridy: el(), hra: el() };
    const calls: { url: string; init: any }[] = [];
    const ctx: any = {
      location: { origin: 'https://ottd.edumise.educraft.cz' },
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
        return { ok: r.status === 200, status: r.status, json: async () => r.body };
      },
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      escape, setInterval, encodeURIComponent, decodeURIComponent, JSON, Object, Date, Error,
    };
    vm.runInNewContext(readFileSync(join(ROOT, 'educraft/brana.js'), 'utf8'), ctx);
    return { els, calls };
  }

  it('pupil: ticket → iframe with #w, then a fresh ticket by postMessage every 90 s', async () => {
    let n = 0;
    const { els, calls } = load(jwt({ 'custom:student_id': 's-1' }), {
      'POST /me/game-ticket': () => ({ status: 200, body: { data: { url: WSS.replace('abc', `t${n++}`), expiresAt: 'x' } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS.replace('abc', 't0')));
    expect(calls.find((c) => c.url.endsWith('/me/game-ticket'))!.init.headers.Authorization).toMatch(/^Bearer h\./);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(els.hra.contentWindow.postMessage).toHaveBeenCalledWith({ t: 'edumise-ticket', url: WSS.replace('abc', 't1') }, 'https://ottd.edumise.educraft.cz');
  });

  it('pupil without a running session sees the Czech notice', async () => {
    const { els } = load(jwt({ 'custom:student_id': 's-1' }), {
      'POST /me/game-ticket': () => ({ status: 409, body: { error: 'no_session' } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.titulek.textContent).toBe('Hodina Dopravy teď neběží.');
    expect(els.hra.src).toBe('');
  });

  it('teacher: single-player button plus "Sledovat třídu" for running classes of UUID schools', async () => {
    const school = '3f0c9a1b-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
    const { els } = load(jwt({ 'cognito:groups': ['TEACHER'], [`schools:${school}`]: 'TEACHER', 'schools:12345678': 'TEACHER' }), {
      [`GET /classes?schoolId=${school}`]: () => ({
        status: 200,
        body: { data: { classes: [
          { classId: 'k1', className: '6.I', session: 'running', canManage: true },
          { classId: 'k2', className: '7.C', session: 'stopped', canManage: true },
        ] } },
      }),
      'POST /classes/k1/game-ticket': (body) => ({ status: body.schoolId === school ? 200 : 403, body: { data: { url: WSS } } }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(els.tridy.children.map((b: any) => b.textContent)).toEqual(['Hrát samostatně', 'Sledovat třídu 6.I']);
    await els.tridy.children[1].listeners[0]();
    expect(els.hra.src).toBe('openttd.html#w=' + encodeURIComponent(WSS));
  });
});
