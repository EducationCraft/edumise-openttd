/** renew-cert handler with SSM, Route53 and acme-client mocked: when it renews, the DNS-01 dance, what lands in SSM. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../lambda/renew-cert'; // vi.mock below is hoisted above this import

const ssmSend = vi.fn();
const r53Send = vi.fn();
const acmeClients: any[] = [];
const autoOpts: any[] = [];
let autoImpl: (o: any) => Promise<string>;

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { kind = 'Get'; constructor(public input: any) {} },
  PutParameterCommand: class { kind = 'Put'; constructor(public input: any) {} },
}));
vi.mock('@aws-sdk/client-route-53', () => ({
  Route53Client: class { constructor(public cfg: any) {} send = r53Send; },
  ChangeResourceRecordSetsCommand: class { kind = 'Change'; constructor(public input: any) {} },
  GetChangeCommand: class { kind = 'GetChange'; constructor(public input: any) {} },
}));
vi.mock('acme-client', () => ({
  directory: { letsencrypt: { production: 'https://acme-v02.api.letsencrypt.org/directory' } },
  crypto: {
    createPrivateEcdsaKey: async () => Buffer.from('PRIVATE-KEY'),
    createCsr: async (o: any) => { autoOpts.push({ csr: o }); return [Buffer.from('CERT-KEY'), Buffer.from('CSR')]; },
  },
  Client: class {
    constructor(public opts: any) { acmeClients.push(opts); }
    auto(o: any) { autoOpts.push(o); return autoImpl(o); }
  },
}));

function cert(days: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'renew-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', String(days),
    '-subj', '/CN=x', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  return readFileSync(join(dir, 'c.pem'), 'utf8');
}

let fresh: string;
let expiring: string;
beforeAll(() => {
  fresh = cert(90);
  expiring = cert(10);
});

const stored = (c: string) => ({ Parameter: { Value: JSON.stringify({ cert: c, key: 'k' }) } });
const notFound = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' });

beforeEach(() => {
  vi.stubEnv('DOMAIN', 'ottd-server.edumise.educraft.cz');
  vi.stubEnv('HOSTED_ZONE_ID', 'Z123');
  vi.stubEnv('PARAM', '/edumise-doprava/prod/tls');
  vi.stubEnv('ACME_DIRECTORY', '');
  delete process.env.ACME_DIRECTORY;
  ssmSend.mockReset();
  r53Send.mockReset();
  acmeClients.length = 0;
  autoOpts.length = 0;
  autoImpl = async (o) => {
    const authz = { identifier: { value: 'ottd-server.edumise.educraft.cz' } };
    await o.challengeCreateFn(authz, {}, 'key-auth');
    await o.challengeRemoveFn(authz, {}, 'key-auth');
    return fresh;
  };
  let polls = 0;
  r53Send.mockImplementation(async (cmd: any) =>
    cmd.kind === 'Change' ? { ChangeInfo: { Id: `/change/${cmd.input.ChangeBatch.Changes[0].Action}` } }
      : { ChangeInfo: { Status: polls++ % 2 === 0 ? 'PENDING' : 'INSYNC' } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Runs the handler while letting the 5 s INSYNC polls pass. */
async function run() {
  vi.useFakeTimers();
  const p = handler();
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(60_000);
  return p;
}

describe('renew-cert handler', () => {
  it('leaves a certificate with more than 30 days alone', async () => {
    ssmSend.mockResolvedValue(stored(fresh));
    const r = await handler();
    expect(r.renewed).toBe(false);
    expect(r.daysLeft).toBeGreaterThanOrEqual(89);
    expect(ssmSend).toHaveBeenCalledTimes(1);
    expect(ssmSend.mock.calls[0][0].input).toEqual({ Name: '/edumise-doprava/prod/tls', WithDecryption: true });
    expect(acmeClients).toEqual([]);
    expect(r53Send).not.toHaveBeenCalled();
  });

  it('renews an expiring wildcard via DNS-01, waits for INSYNC, cleans up and stores cert+key in one SecureString', async () => {
    ssmSend.mockImplementation(async (cmd: any) => (cmd.kind === 'Get' ? stored(expiring) : {}));
    const r = await run();
    expect(r.renewed).toBe(true);
    expect(r.daysLeft).toBeGreaterThanOrEqual(89);

    expect(acmeClients).toEqual([{ directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory', accountKey: Buffer.from('PRIVATE-KEY') }]);
    expect(autoOpts[0]).toEqual({ csr: { commonName: '*.ottd-server.edumise.educraft.cz' } });
    expect(autoOpts[1]).toMatchObject({ csr: Buffer.from('CSR'), termsOfServiceAgreed: true, challengePriority: ['dns-01'], skipChallengeVerification: true });

    const changes = r53Send.mock.calls.map((c) => c[0]).filter((c) => c.kind === 'Change').map((c) => c.input);
    expect(changes).toEqual(['UPSERT', 'DELETE'].map((Action) => ({
      HostedZoneId: 'Z123',
      ChangeBatch: { Changes: [{ Action, ResourceRecordSet: { Name: '_acme-challenge.ottd-server.edumise.educraft.cz', Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"key-auth"' }] } }] },
    })));
    // each change is polled until INSYNC (PENDING first), by its own change id
    expect(r53Send.mock.calls.map((c) => c[0]).filter((c) => c.kind === 'GetChange').map((c) => c.input.Id))
      .toEqual(['/change/UPSERT', '/change/UPSERT', '/change/DELETE', '/change/DELETE']);

    const put = ssmSend.mock.calls.map((c) => c[0]).find((c) => c.kind === 'Put').input;
    expect(put).toMatchObject({ Name: '/edumise-doprava/prod/tls', Type: 'SecureString', Overwrite: true, Tier: 'Intelligent-Tiering' });
    expect(JSON.parse(put.Value)).toEqual({ cert: fresh, key: 'CERT-KEY' });
  });

  it('issues the first certificate when the parameter does not exist yet, honouring ACME_DIRECTORY', async () => {
    vi.stubEnv('ACME_DIRECTORY', 'https://acme-staging-v02.api.letsencrypt.org/directory');
    ssmSend.mockImplementation(async (cmd: any) => { if (cmd.kind === 'Get') throw notFound(); return {}; });
    expect((await run()).renewed).toBe(true);
    expect(acmeClients[0].directoryUrl).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
    expect(ssmSend.mock.calls.some((c) => c[0].kind === 'Put')).toBe(true);
  });

  it('fails the invocation on any other SSM read error, before touching ACME', async () => {
    ssmSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(handler()).rejects.toThrow('denied');
    expect(acmeClients).toEqual([]);
  });

  it('fails without storing anything when ACME fails', async () => {
    ssmSend.mockImplementation(async (cmd: any) => (cmd.kind === 'Get' ? stored(expiring) : {}));
    autoImpl = async () => { throw new Error('urn:ietf:params:acme:error:rateLimited'); };
    await expect(run()).rejects.toThrow('rateLimited');
    expect(ssmSend.mock.calls.some((c) => c[0].kind === 'Put')).toBe(false);
  });

  it('fails on missing configuration', async () => {
    for (const k of ['DOMAIN', 'HOSTED_ZONE_ID', 'PARAM']) {
      vi.stubEnv(k, '');
      await expect(handler()).rejects.toThrow(`missing env ${k}`);
      vi.stubEnv(k, 'x');
    }
    expect(ssmSend).not.toHaveBeenCalled();
  });
});
