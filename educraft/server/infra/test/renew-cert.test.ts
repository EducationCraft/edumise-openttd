import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENEW_DAYS, daysLeft } from '../lambda/renew-cert';

describe('renew-cert', () => {
  it('counts the days a certificate has left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'renew-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '90',
      '-subj', '/CN=x', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    const pem = readFileSync(join(dir, 'c.pem'), 'utf8');
    expect(Math.round(daysLeft(pem, new Date()))).toBe(90);
    expect(daysLeft(pem, new Date(Date.now() + 61 * 86_400_000))).toBeLessThan(RENEW_DAYS);
  });
});
