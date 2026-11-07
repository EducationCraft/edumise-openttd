/** HttpWallet (contract §3.5) against a stubbed fetch: M2M token cache, X-Game-Token, one retry on 401. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpWallet } from '../src/wallet';

const cfg = {
  base: 'https://wallet.test/wallet',
  gameKey: 'g1',
  clientId: 'cid',
  clientSecret: 'csecret',
  gameToken: 'game-tok',
  tokenEndpoint: 'https://auth.test/oauth2/token',
};

type Reply = { status: number; body?: string };
let calls: { url: string; init: any }[];
let tokenReplies: Reply[];
let apiReplies: Reply[];

const res = (r: Reply) => ({
  ok: r.status >= 200 && r.status < 300,
  status: r.status,
  json: async () => JSON.parse(r.body ?? ''),
  text: async () => r.body ?? '',
});

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  tokenReplies = [];
  apiReplies = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ url, init });
    const q = url === cfg.tokenEndpoint ? tokenReplies : apiReplies;
    const r = q.shift();
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return res(r);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const token = (t: string, expiresIn?: number) => ({ status: 200, body: JSON.stringify({ access_token: t, expires_in: expiresIn }) });
const tokenCalls = () => calls.filter((c) => c.url === cfg.tokenEndpoint);

describe('HttpWallet', () => {
  it('gets a client_credentials token with Basic auth and calls the game path with both tokens', async () => {
    tokenReplies.push(token('m2m-1', 3600));
    apiReplies.push({ status: 200, body: '{"data":{"ok":true}}' });
    const w = new HttpWallet(cfg);
    expect(await w.call('POST', '/hello', { gsLastSeq: 3 })).toEqual({ status: 200, body: { data: { ok: true } } });

    const [t, api] = calls;
    expect(t.init.method).toBe('POST');
    expect(t.init.headers.Authorization).toBe('Basic ' + Buffer.from('cid:csecret').toString('base64'));
    expect(t.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(t.init.body).toBe('grant_type=client_credentials&scope=wallet%2Fgame');
    expect(api.url).toBe('https://wallet.test/wallet/game/g1/hello');
    expect(api.init.method).toBe('POST');
    expect(api.init.headers).toEqual({ Authorization: 'Bearer m2m-1', 'X-Game-Token': 'game-tok', 'Content-Type': 'application/json' });
    expect(api.init.body).toBe('{"gsLastSeq":3}');
  });

  it('sends no body and no Content-Type on a GET', async () => {
    tokenReplies.push(token('m2m-1'));
    apiReplies.push({ status: 200, body: '{"data":{}}' });
    await new HttpWallet(cfg).call('GET', '/slots');
    expect(calls[1].init.body).toBeUndefined();
    expect(calls[1].init.headers).not.toHaveProperty('Content-Type');
  });

  it('reuses the token until 60 s before expiry, then fetches a new one', async () => {
    tokenReplies.push(token('m2m-1', 600), token('m2m-2', 600));
    apiReplies.push(...Array(3).fill({ status: 200, body: '{}' }));
    const w = new HttpWallet(cfg);
    await w.call('GET', '/ops');
    vi.advanceTimersByTime(539_000);
    await w.call('GET', '/ops');
    expect(tokenCalls()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    await w.call('GET', '/ops');
    expect(tokenCalls()).toHaveLength(2);
    expect(calls.at(-1)!.init.headers.Authorization).toBe('Bearer m2m-2');
  });

  it('defaults a missing expires_in to one hour', async () => {
    tokenReplies.push(token('m2m-1'), token('m2m-2'));
    apiReplies.push(...Array(3).fill({ status: 200, body: '{}' }));
    const w = new HttpWallet(cfg);
    await w.call('GET', '/ops');
    vi.advanceTimersByTime(3_539_000);
    await w.call('GET', '/ops');
    expect(tokenCalls()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    await w.call('GET', '/ops');
    expect(tokenCalls()).toHaveLength(2);
  });

  it('on 401 drops the token and retries once with a fresh one', async () => {
    tokenReplies.push(token('old', 3600), token('new', 3600));
    apiReplies.push({ status: 401, body: '{"error":"unauthorized"}' }, { status: 200, body: '{"data":1}' });
    const r = await new HttpWallet(cfg).call('POST', '/ops/7/result', { ok: true });
    expect(r).toEqual({ status: 200, body: { data: 1 } });
    const api = calls.filter((c) => c.url !== cfg.tokenEndpoint);
    expect(api.map((c) => c.init.headers.Authorization)).toEqual(['Bearer old', 'Bearer new']);
    expect(api[1].init.body).toBe('{"ok":true}');
  });

  it('a second 401 in a row comes back as a status, without a third request', async () => {
    tokenReplies.push(token('a'), token('b'));
    apiReplies.push({ status: 401, body: '' }, { status: 401, body: '{"error":"unauthorized"}' });
    expect(await new HttpWallet(cfg).call('GET', '/slots')).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(calls).toHaveLength(4);
  });

  it('returns HTTP errors as status with the parsed body; an empty or non-JSON body is null', async () => {
    tokenReplies.push(token('t'));
    apiReplies.push({ status: 409, body: '{"error":"reset_pending","resetId":"r"}' }, { status: 502, body: '<html>Bad gateway</html>' }, { status: 204, body: '' });
    const w = new HttpWallet(cfg);
    expect(await w.call('POST', '/hello', {})).toEqual({ status: 409, body: { error: 'reset_pending', resetId: 'r' } });
    expect(await w.call('GET', '/ops')).toEqual({ status: 502, body: null });
    expect(await w.call('GET', '/ops')).toEqual({ status: 204, body: null });
  });

  it('throws when the token endpoint refuses or returns no access_token, and does not cache a failure', async () => {
    tokenReplies.push({ status: 400, body: '{"error":"invalid_client"}' }, { status: 200, body: '{"token_type":"Bearer"}' }, token('ok'));
    apiReplies.push({ status: 200, body: '{}' });
    const w = new HttpWallet(cfg);
    await expect(w.call('GET', '/ops')).rejects.toThrow('token endpoint HTTP 400');
    await expect(w.call('GET', '/ops')).rejects.toThrow('token endpoint returned no access_token');
    expect((await w.call('GET', '/ops')).status).toBe(200);
    expect(calls.filter((c) => c.url !== cfg.tokenEndpoint)).toHaveLength(1);
  });

  it('passes a timeout signal and propagates network errors', async () => {
    tokenReplies.push(token('t'));
    const w = new HttpWallet({ ...cfg, timeoutMs: 1234 });
    await expect(w.call('GET', '/ops')).rejects.toThrow('unexpected fetch');
    expect(calls.every((c) => c.init.signal instanceof AbortSignal)).toBe(true);
  });
});
