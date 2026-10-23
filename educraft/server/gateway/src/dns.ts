/**
 * Direct access without the ALB: the task points <gameKey>.<domain> at its own public IP.
 * The task role may UPSERT only that one A record (doprava-stack.ts).
 */
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Fargate's task metadata has no public IP; AWS's own echo service is the simplest source. */
export async function publicIp(fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5_000) });
  const ip = (await r.text()).trim();
  if (!r.ok || !IPV4.test(ip)) throw new Error(`no public IP (${r.status} ${ip.slice(0, 40)})`);
  return ip;
}

export async function publishAddress(
  name: string,
  zoneId: string,
  ip: string,
  client: Pick<Route53Client, 'send'> = new Route53Client({ region: 'us-east-1' }),
): Promise<void> {
  await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        // TTL 60: a restarted task gets a new IP, and the gate waits for the server anyway.
        Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: name, Type: 'A', TTL: 60, ResourceRecords: [{ Value: ip }] } }],
      },
    }),
  );
}
