import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DopravaStack } from '../lib/doprava-stack';

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
      Cpu: '1024',
      Memory: '2048',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'openttd', StopTimeout: 120, Environment: [{ Name: 'ADMIN_AUTHORIZED_KEY', Value: 'ab'.repeat(32) }] }),
        Match.objectLike({
          Name: 'gateway',
          StopTimeout: 120,
          PortMappings: [Match.objectLike({ ContainerPort: 8080 })],
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
    const task = policies.find((p) => p.includes('ssm:GetParameter'))!;
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

  it('refuses an invalid game key', () => {
    expect(() => synth([{ gameKey: '6.I' }])).toThrow(/invalid gameKey/);
  });
});
