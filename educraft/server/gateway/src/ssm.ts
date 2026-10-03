/**
 * Secrets from SSM Parameter Store (SecureString, WithDecryption), cached per process.
 * Vzor kokpit-backend/lib/ssm.ts, but SSM only — no env or Secrets Manager fallback (contract §1.2).
 * LOCAL_SECRETS_DIR (docker-compose only) reads the same names from files instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

let client: SSMClient | undefined;
const cache = new Map<string, string>();

export async function getSecret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit) return hit;
  let value: string | undefined;
  const localDir = process.env.LOCAL_SECRETS_DIR;
  if (localDir) {
    value = readFileSync(join(localDir, name), 'utf8').trim();
  } else {
    client ??= new SSMClient({ region: process.env.AWS_REGION ?? 'eu-central-1' });
    const r = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    value = r.Parameter?.Value;
  }
  if (!value) throw new Error(`secret ${name} has no value`);
  cache.set(name, value);
  return value;
}
