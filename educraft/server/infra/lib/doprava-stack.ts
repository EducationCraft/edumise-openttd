/**
 * EduMise Doprava game servers (contract §6.1): one Fargate service per class game,
 * desiredCount 0 until the wallet starts a session (ecs:UpdateService, §6.6).
 * Shared: VPC (public subnets, no NAT), cluster, EFS, ECR. No load balancer: each gateway serves
 * WSS on :443 as <gameKey>.DIRECT_DOMAIN with a Let's Encrypt wildcard that a daily Lambda keeps
 * in SSM (lambda/renew-cert.ts).
 */
import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface Game {
  gameKey: string;
}

export interface DopravaProps extends StackProps {
  games: Game[];
  /** edumise-openttd git SHA; must equal the SHA of the deployed WASM client. */
  imageTag: string;
  /** X25519 public key of the bridge (hex); the private half is SSM admin-private-key. */
  adminPublicKey: string;
  walletClientId: string;
  walletBase: string;
}

const SECRETS_PREFIX = '/edumise-doprava/prod';
/** <gameKey>.DIRECT_DOMAIN → the task's public IP, written by the gateway itself. */
export const DIRECT_DOMAIN = 'ottd-server.edumise.educraft.cz';
/** Route53 zone educraft.cz. */
export const HOSTED_ZONE_ID = 'Z05772991Q99U0Y3XXBDS';
const TLS_PARAM = `${SECRETS_PREFIX}/tls/bundle`;
const METRICS_NS = 'EduMiseDoprava';
export const GAME_KEY_RE = /^c[0-9a-f]{12}$/;

export class DopravaStack extends Stack {
  constructor(scope: Construct, id: string, props: DopravaProps) {
    super(scope, id, props);
    Tags.of(this).add('product', 'edumise-doprava');
    Tags.of(this).add('owner', 'tomas.barin@gmail.com');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const serverRepo = new ecr.Repository(this, 'ServerRepo', {
      repositoryName: 'edumise-doprava-server',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const gatewayRepo = new ecr.Repository(this, 'GatewayRepo', {
      repositoryName: 'edumise-doprava-gateway',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { clusterName: 'edumise-doprava', vpc });

    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      securityGroupName: 'edumise-doprava-task',
      description: 'Game tasks: only the gateway on 443 is reachable',
    });
    // Only the gateway listens on 443; it admits nobody without a wallet ticket (proxy.ts).
    taskSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'direct WSS from browsers');

    const fsSg = new ec2.SecurityGroup(this, 'EfsSg', { vpc, description: 'edumise-doprava EFS' });
    fsSg.addIngressRule(taskSg, ec2.Port.tcp(2049), 'NFS from game tasks');
    const fs = new efs.FileSystem(this, 'Efs', {
      fileSystemName: 'edumise-doprava',
      vpc,
      encrypted: true,
      securityGroup: fsSg,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      // Only IAM principals may mount; without a policy EFS lets any NFS client in (§6.1).
      allowAnonymousAccess: false,
    });
    // Every mount must be TLS and go through an access point, so a task role's
    // AccessPointArn condition confines it to /games/<gameKey> (§6.1, §9).
    const nfsActions = ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:ClientRootAccess'];
    fs.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['*'],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );
    fs.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: nfsActions,
        conditions: { Null: { 'elasticfilesystem:AccessPointArn': 'true' } },
      }),
    );

    const alerts = sns.Topic.fromTopicArn(this, 'Alerts', `arn:aws:sns:${this.region}:${this.account}:educraft-alerts`);
    this.tlsRenewal(alerts);
    new cloudwatch.Alarm(this, 'DirectAccessFailedAlarm', {
      alarmName: 'edumise-doprava-direct-access-failed',
      alarmDescription: 'A class gateway could not set up direct WSS (TLS bundle or DNS); pupils cannot join it without the ALB.',
      metric: new cloudwatch.Metric({ namespace: METRICS_NS, metricName: 'DirectAccessFailed', statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(alerts));

    props.games.forEach((g) => {
      if (!GAME_KEY_RE.test(g.gameKey)) throw new Error(`invalid gameKey ${g.gameKey}`);
      this.game(g.gameKey, { cluster, taskSg, fs, serverRepo, gatewayRepo, props });
    });
  }

  private tlsRenewal(alerts: sns.ITopic): void {
    const fn = new nodejs.NodejsFunction(this, 'TlsRenew', {
      functionName: 'edumise-doprava-tls-renew',
      entry: path.join(__dirname, '../lambda/renew-cert.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: { DOMAIN: DIRECT_DOMAIN, HOSTED_ZONE_ID, PARAM: TLS_PARAM },
      logGroup: new logs.LogGroup(this, 'TlsRenewLogs', {
        logGroupName: '/aws/lambda/edumise-doprava-tls-renew',
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:aws:route53:::hostedzone/${HOSTED_ZONE_ID}`],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [`_acme-challenge.${DIRECT_DOMAIN}`],
            'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
          },
        },
      }),
    );
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['route53:GetChange'], resources: ['arn:aws:route53:::change/*'] }));
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${TLS_PARAM}`],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );
    new events.Rule(this, 'TlsRenewDaily', {
      ruleName: 'edumise-doprava-tls-renew',
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
      targets: [new targets.LambdaFunction(fn)],
    });
    new cloudwatch.Alarm(this, 'TlsRenewAlarm', {
      alarmName: 'edumise-doprava-tls-renew-failed',
      alarmDescription: 'The direct-WSS certificate did not renew; it expires within 30 days of the first failure.',
      metric: fn.metricErrors({ period: Duration.days(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(alerts));
  }

  private game(
    key: string,
    s: {
      cluster: ecs.Cluster;
      taskSg: ec2.SecurityGroup;
      fs: efs.FileSystem;
      serverRepo: ecr.Repository;
      gatewayRepo: ecr.Repository;
      props: DopravaProps;
    },
  ): void {
    const scope = new Construct(this, `Game-${key}`);
    const ap = s.fs.addAccessPoint(`Ap-${key}`, {
      path: `/games/${key}`,
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
    });

    // Task role: only its own game's secrets and its own access point (§6.1).
    const role = new iam.Role(scope, 'TaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    const param = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`;
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          param(`${SECRETS_PREFIX}/wallet-client-secret`),
          param(`${SECRETS_PREFIX}/admin-private-key`),
          param(`${SECRETS_PREFIX}/games/${key}/*`),
          param(TLS_PARAM),
        ],
      }),
    );
    // Its own A record and nothing else (gateway dns.ts).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:aws:route53:::hostedzone/${HOSTED_ZONE_ID}`],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [`${key}.${DIRECT_DOMAIN}`],
            'route53:ChangeResourceRecordSetsRecordTypes': ['A'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT'],
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        resources: [s.fs.fileSystemArn],
        conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': ap.accessPointArn } },
      }),
    );

    const logGroup = new logs.LogGroup(scope, 'Logs', {
      logGroupName: `/ecs/edumise-doprava/${key}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    logGroup.addMetricFilter('DirectAccessFailed', {
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'direct access failed'),
      metricNamespace: METRICS_NS,
      metricName: 'DirectAccessFailed',
      metricValue: '1',
    });

    const task = new ecs.FargateTaskDefinition(scope, 'Task', {
      family: `doprava-${key}`,
      // 2 vCPU / 4 GB for the 4096 x 4096 map (2026-10-17; was 1 vCPU / 2 GB for 1024 x 1024).
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskRole: role,
      volumes: [
        {
          name: 'data',
          efsVolumeConfiguration: {
            fileSystemId: s.fs.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: ap.accessPointId, iam: 'ENABLED' },
          },
        },
      ],
    });

    const openttd = task.addContainer('openttd', {
      image: ecs.ContainerImage.fromEcrRepository(s.serverRepo, s.props.imageTag),
      essential: true,
      stopTimeout: Duration.seconds(120),
      environment: { ADMIN_AUTHORIZED_KEY: s.props.adminPublicKey },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'openttd' }),
    });
    openttd.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false });

    const gateway = task.addContainer('gateway', {
      image: ecs.ContainerImage.fromEcrRepository(s.gatewayRepo, s.props.imageTag),
      essential: true,
      stopTimeout: Duration.seconds(120),
      portMappings: [{ containerPort: 443 }],
      environment: {
        GAME_KEY: key,
        DIRECT_DOMAIN,
        HOSTED_ZONE_ID,
        SECRETS_PREFIX,
        WALLET_BASE: s.props.walletBase,
        WALLET_CLIENT_ID: s.props.walletClientId,
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'gateway' }),
    });
    gateway.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false });
    // START (not HEALTHY): ECS stops dependants first, so the bridge's SIGTERM save runs
    // while the server is still up (§4.5 step 12).
    gateway.addContainerDependencies({ container: openttd, condition: ecs.ContainerDependencyCondition.START });

    const service = new ecs.FargateService(scope, 'Service', {
      serviceName: `doprava-${key}`,
      cluster: s.cluster,
      taskDefinition: task,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [s.taskSg],
      // Never two servers on one save: stop the old task before a new one starts.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
  }
}
