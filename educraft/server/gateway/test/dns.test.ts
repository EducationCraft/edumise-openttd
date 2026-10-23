import { describe, expect, it } from 'vitest';
import { publicIp, publishAddress } from '../src/dns';

describe('direct access DNS', () => {
  it('takes the public IP from checkip and refuses anything else', async () => {
    const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await publicIp(reply('3.120.1.2\n'))).toBe('3.120.1.2');
    await expect(publicIp(reply('<html>'))).rejects.toThrow(/no public IP/);
    await expect(publicIp(reply('3.120.1.2', 500))).rejects.toThrow(/no public IP/);
  });

  it('upserts one A record with TTL 60', async () => {
    const sent: any[] = [];
    await publishAddress('c3f0c9a1b2c4d.ottd-server.edumise.educraft.cz', 'Z1', '3.120.1.2', { send: async (c: any) => sent.push(c.input) } as any);
    expect(sent).toEqual([{
      HostedZoneId: 'Z1',
      ChangeBatch: { Changes: [{ Action: 'UPSERT', ResourceRecordSet: {
        Name: 'c3f0c9a1b2c4d.ottd-server.edumise.educraft.cz', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '3.120.1.2' }] } }] },
    }]);
  });
});
