/** getSecret: SSM SecureString with decryption, per-process cache, LOCAL_SECRETS_DIR for docker-compose. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const clients: any[] = [];
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    constructor(public cfg: any) { clients.push(cfg); }
    send = send;
  },
  GetParameterCommand: class { constructor(public input: any) {} },
}));

// A fresh module per test: the cache and the client live at module level.
const load = async () => (await import('../src/ssm')).getSecret;

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  clients.length = 0;
  vi.stubEnv('LOCAL_SECRETS_DIR', '');
  vi.stubEnv('AWS_REGION', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('getSecret', () => {
  it('reads a SecureString with decryption from eu-central-1 and caches it', async () => {
    delete process.env.AWS_REGION;
    send.mockResolvedValue({ Parameter: { Value: 's3cret' } });
    const getSecret = await load();
    expect(await getSecret('/edumise-doprava/prod/x')).toBe('s3cret');
    expect(await getSecret('/edumise-doprava/prod/x')).toBe('s3cret');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({ Name: '/edumise-doprava/prod/x', WithDecryption: true });
    expect(clients).toEqual([{ region: 'eu-central-1' }]);
  });

  it('uses AWS_REGION and one client for several names', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    send.mockResolvedValueOnce({ Parameter: { Value: 'a' } }).mockResolvedValueOnce({ Parameter: { Value: 'b' } });
    const getSecret = await load();
    expect([await getSecret('/a'), await getSecret('/b')]).toEqual(['a', 'b']);
    expect(clients).toEqual([{ region: 'eu-west-1' }]);
  });

  it('throws on an empty or missing value and does not cache it', async () => {
    delete process.env.AWS_REGION;
    send.mockResolvedValueOnce({ Parameter: { Value: '' } }).mockResolvedValueOnce({}).mockResolvedValueOnce({ Parameter: { Value: 'late' } });
    const getSecret = await load();
    await expect(getSecret('/x')).rejects.toThrow('secret /x has no value');
    await expect(getSecret('/x')).rejects.toThrow('secret /x has no value');
    expect(await getSecret('/x')).toBe('late');
  });

  it('propagates SSM errors (e.g. AccessDenied) without caching', async () => {
    delete process.env.AWS_REGION;
    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    send.mockResolvedValueOnce({ Parameter: { Value: 'ok' } });
    const getSecret = await load();
    await expect(getSecret('/x')).rejects.toThrow('denied');
    expect(await getSecret('/x')).toBe('ok');
  });

  it('with LOCAL_SECRETS_DIR reads the trimmed file of the same name and never touches SSM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
    writeFileSync(join(dir, 'wallet-client-secret'), '  local\n');
    writeFileSync(join(dir, 'blank'), ' \n');
    vi.stubEnv('LOCAL_SECRETS_DIR', dir);
    const getSecret = await load();
    expect(await getSecret('wallet-client-secret')).toBe('local');
    await expect(getSecret('blank')).rejects.toThrow('secret blank has no value');
    await expect(getSecret('missing')).rejects.toThrow(/ENOENT/);
    expect(send).not.toHaveBeenCalled();
    expect(clients).toEqual([]);
  });
});
