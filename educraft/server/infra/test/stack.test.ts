import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import games from '../games.json';
import { DIRECT_DOMAIN, DopravaStack, HOSTED_ZONE_ID } from '../lib/doprava-stack';

const KEY = 'c3f0c9a1b2c4d';
const synth = (games = [{ gameKey: KEY }]) =>
  Template.fromStack(
    new DopravaStack(new App(), 'T', {
      env: { account: '111111111111', region: 'eu-central-1' },
      games,
      imageTag: 'abc123',
      certificateArn: 'arn:aws:acm:eu-central-1:111111111111:certificate/x',
      adminPublicKey: 'ab'.repeat(32),
      walletClientId: 'client',
      walletBase: 'https://api.educraft.cz/wallet',
    }),
  );

describe('DopravaStack (contract §6.1)', () => {
  const t = synth();

  it('per-game service starts stopped and never overlaps two servers', () => {
    t.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: `doprava-${KEY}`,
      DesiredCount: 0,
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }) },
    });
  });

  it('task definition: two containers, gateway depends on openttd START, EFS access point', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: `doprava-${KEY}`,
      Cpu: '2048',
      Memory: '4096',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'openttd', StopTimeout: 120, Environment: [{ Name: 'ADMIN_AUTHORIZED_KEY', Value: 'ab'.repeat(32) }] }),
        Match.objectLike({
          Name: 'gateway',
          StopTimeout: 120,
          PortMappings: [Match.objectLike({ ContainerPort: 8080 }), Match.objectLike({ ContainerPort: 443 })],
          DependsOn: [{ ContainerName: 'openttd', Condition: 'START' }],
          Environment: Match.arrayWith([{ Name: 'GAME_KEY', Value: KEY }, { Name: 'SECRETS_PREFIX', Value: '/edumise-doprava/prod' }]),
        }),
      ]),
      Volumes: [Match.objectLike({ EFSVolumeConfiguration: Match.objectLike({ TransitEncryption: 'ENABLED' }) })],
    });
    t.hasResourceProperties('AWS::EFS::AccessPoint', {
      RootDirectory: Match.objectLike({ Path: `/games/${KEY}` }),
      PosixUser: { Uid: '1000', Gid: '1000' },
    });
  });

  it('task role reads only this game\'s secrets', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).map((p: any) => JSON.stringify(p.Properties.PolicyDocument));
    const task = policies.find((p) => p.includes('ssm:GetParameter') && p.includes('admin-private-key'))!;
    expect(task).toContain(`/edumise-doprava/prod/games/${KEY}/*`);
    expect(task).toContain('/edumise-doprava/prod/admin-private-key');
    expect(task).not.toMatch(/games\/\*/);
  });

  it('ALB routes /g/<gameKey> to the game and 404s the rest', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: [`/g/${KEY}`, `/g/${KEY}/*`] } }],
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: `edm-${KEY}`,
      HealthCheckPath: '/healthz',
      TargetType: 'ip',
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Name: 'edumise-doprava',
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '300' }]),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      DefaultActions: [Match.objectLike({ Type: 'fixed-response', FixedResponseConfig: Match.objectLike({ StatusCode: '404' }) })],
    });
  });

  it('EFS: no anonymous mounts, TLS only, access points only', () => {
    const fsPolicy = JSON.stringify(Object.values(t.findResources('AWS::EFS::FileSystem'))[0].Properties.FileSystemPolicy);
    expect(fsPolicy).toContain('"aws:SecureTransport":"false"');
    expect(fsPolicy).toContain('"elasticfilesystem:AccessPointArn":"true"');
    expect(fsPolicy).toContain('"elasticfilesystem:AccessedViaMountTarget":"true"');
    const stmts = JSON.parse(fsPolicy).Statement;
    // ClientMount is never granted by the resource policy: only the per-game task role has it.
    expect(stmts.filter((x: any) => x.Effect === 'Allow' && [x.Action].flat().includes('elasticfilesystem:ClientMount'))).toEqual([]);
  });

  it('logs kept 90 days, no NAT gateway', () => {
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/ecs/edumise-doprava/${KEY}`, RetentionInDays: 90 });
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('every game in games.json gets a stopped service with a 180 s health-check grace (big map load)', () => {
    const keys = games.map((g) => g.gameKey);
    expect(new Set(keys).size).toBe(keys.length);
    const services = Object.values(synth(games).findResources('AWS::ECS::Service')).map((r: any) => r.Properties);
    expect(services.map((p) => p.ServiceName).sort()).toEqual(keys.map((k) => `doprava-${k}`).sort());
    for (const p of services) {
      expect(p.DesiredCount).toBe(0);
      expect(p.HealthCheckGracePeriodSeconds).toBe(180);
      expect(p.DeploymentConfiguration).toMatchObject({ MinimumHealthyPercent: 0, MaximumPercent: 100 });
    }
  });

  it('direct WSS: :443 open to browsers, gateway env, own A record only', () => {
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'edumise-doprava-task',
      SecurityGroupIngress: Match.arrayWith([Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443 })]),
    });
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'gateway',
          PortMappings: [Match.objectLike({ ContainerPort: 8080 }), Match.objectLike({ ContainerPort: 443 })],
          Environment: Match.arrayWith([
            { Name: 'DIRECT_DOMAIN', Value: DIRECT_DOMAIN },
            { Name: 'HOSTED_ZONE_ID', Value: HOSTED_ZONE_ID },
          ]),
        }),
      ]),
    });
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).map((p: any) => JSON.stringify(p.Properties.PolicyDocument));
    const task = policies.find((p) => p.includes('ssm:GetParameter') && p.includes('admin-private-key'))!;
    expect(task).toContain('/edumise-doprava/prod/tls/bundle');
    expect(task).toContain(`"route53:ChangeResourceRecordSetsNormalizedRecordNames":["${KEY}.${DIRECT_DOMAIN}"]`);
    expect(task).toContain('"route53:ChangeResourceRecordSetsActions":["UPSERT"]');
    t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '{ $.msg = "direct access failed" }' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'edumise-doprava-direct-access-failed' });
  });

  it('TLS renewal: daily Lambda, only the ACME TXT record, failure alarm', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'edumise-doprava-tls-renew',
      Environment: { Variables: { DOMAIN: DIRECT_DOMAIN, HOSTED_ZONE_ID, PARAM: '/edumise-doprava/prod/tls/bundle' } },
    });
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 3 * * ? *)' });
    const renew = Object.values(t.findResources('AWS::IAM::Policy'))
      .map((p: any) => JSON.stringify(p.Properties.PolicyDocument))
      .find((p) => p.includes('ssm:PutParameter'))!;
    expect(renew).toContain(`"route53:ChangeResourceRecordSetsNormalizedRecordNames":["_acme-challenge.${DIRECT_DOMAIN}"]`);
    expect(renew).toContain('"route53:ChangeResourceRecordSetsRecordTypes":["TXT"]');
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'edumise-doprava-tls-renew-failed',
      AlarmActions: ['arn:aws:sns:eu-central-1:111111111111:educraft-alerts'],
    });
  });

  it('refuses an invalid game key', () => {
    expect(() => synth([{ gameKey: '6.I' }])).toThrow(/invalid gameKey/);
  });
});
