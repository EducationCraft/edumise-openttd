/**
 * Daily: keeps a Let's Encrypt wildcard *.<DOMAIN> in SSM for the gateways' direct WSS (no ALB).
 * Renews when fewer than RENEW_DAYS are left (LE certs live 90 days), via DNS-01 in Route53.
 * Gateways read the bundle when a task starts; a session lasts ≤ 4 h, so nobody needs a reload.
 * A thrown error fails the invocation → Errors alarm; with 30 days of daily retries that is the
 * whole warning window before classes lose direct access.
 */
import { X509Certificate } from 'node:crypto';
import { ChangeResourceRecordSetsCommand, GetChangeCommand, Route53Client } from '@aws-sdk/client-route-53';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import * as acme from 'acme-client';

export const RENEW_DAYS = 30;

export function daysLeft(certPem: string, now: Date): number {
  return (Date.parse(new X509Certificate(certPem).validTo) - now.getTime()) / 86_400_000;
}

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export async function handler(): Promise<{ renewed: boolean; daysLeft: number }> {
  const domain = env('DOMAIN');
  const zoneId = env('HOSTED_ZONE_ID');
  const param = env('PARAM');
  const ssm = new SSMClient({});
  const r53 = new Route53Client({ region: 'us-east-1' });

  const current = await ssm
    .send(new GetParameterCommand({ Name: param, WithDecryption: true }))
    .then((r) => JSON.parse(r.Parameter!.Value!) as { cert: string; key: string })
    .catch((e) => {
      if ((e as { name?: string }).name === 'ParameterNotFound') return null;
      throw e;
    });
  if (current) {
    const left = daysLeft(current.cert, new Date());
    if (left > RENEW_DAYS) return { renewed: false, daysLeft: Math.floor(left) };
  }

  const txt = async (action: 'UPSERT' | 'DELETE', name: string, value: string) => {
    const r = await r53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: { Changes: [{ Action: action, ResourceRecordSet: { Name: name, Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: `"${value}"` }] } }] },
      }),
    );
    // INSYNC = every Route53 name server answers with it, which is what LE's validators ask.
    for (let id = r.ChangeInfo!.Id!; ; ) {
      const s = await r53.send(new GetChangeCommand({ Id: id }));
      if (s.ChangeInfo?.Status === 'INSYNC') return;
      await new Promise((ok) => setTimeout(ok, 5_000));
    }
  };

  const client = new acme.Client({
    directoryUrl: process.env.ACME_DIRECTORY ?? acme.directory.letsencrypt.production,
    // ponytail: a fresh account per renewal (every ~60 days), far below LE's account rate limits.
    accountKey: await acme.crypto.createPrivateEcdsaKey(),
  });
  const [key, csr] = await acme.crypto.createCsr({ commonName: `*.${domain}` }, await acme.crypto.createPrivateEcdsaKey());
  const cert = await client.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    // Our own wait for INSYNC replaces acme-client's resolver check (Lambda's resolver caches NXDOMAIN).
    skipChallengeVerification: true,
    challengeCreateFn: (authz, _c, keyAuth) => txt('UPSERT', `_acme-challenge.${authz.identifier.value}`, keyAuth),
    challengeRemoveFn: (authz, _c, keyAuth) => txt('DELETE', `_acme-challenge.${authz.identifier.value}`, keyAuth),
  });

  await ssm.send(
    new PutParameterCommand({
      Name: param,
      Type: 'SecureString',
      Overwrite: true,
      // Moves to the advanced tier by itself should the chain ever outgrow 4 KB.
      Tier: 'Intelligent-Tiering',
      // One parameter for both halves, so a gateway never reads a new cert with an old key.
      Value: JSON.stringify({ cert, key: key.toString() }),
    }),
  );
  return { renewed: true, daysLeft: Math.floor(daysLeft(cert, new Date())) };
}
