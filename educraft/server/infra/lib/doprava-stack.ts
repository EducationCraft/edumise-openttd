/**
 * EduMise Doprava game servers (contract §6.1): one Fargate service per class game,
 * desiredCount 0 until the wallet starts a session (ecs:UpdateService, §6.6).
 * Shared: VPC (public subnets, no NAT), cluster, ALB with a path rule per game, EFS, ECR.
 */
import { Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface Game {
  gameKey: string;
}

export interface DopravaProps extends StackProps {
  games: Game[];
  /** edumise-openttd git SHA; must equal the SHA of the deployed WASM client. */
  imageTag: string;
  /** ACM cert for doprava.edumise.educraft.cz in eu-central-1 (handover, §8 B). */
  certificateArn: string;
  /** X25519 public key of the bridge (hex); the private half is SSM admin-private-key. */
  adminPublicKey: string;
  walletClientId: string;
  walletBase: string;
}

const SECRETS_PREFIX = '/edumise-doprava/prod';
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

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'edumise-doprava ALB' });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS / WSS from browsers');
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      securityGroupName: 'edumise-doprava-task',
      description: 'Game tasks: only the ALB may reach the gateway',
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'gateway from the ALB');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: 'edumise-doprava',
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(300),
    });
    const listener = alb.addListener('Https', {
      port: 443,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'not found' }),
      open: false,
    });

    const fsSg = new ec2.SecurityGroup(this, 'EfsSg', { vpc, description: 'edumise-doprava EFS' });
    fsSg.addIngressRule(taskSg, ec2.Port.tcp(2049), 'NFS from game tasks');
    const fs = new efs.FileSystem(this, 'Efs', {
      fileSystemName: 'edumise-doprava',
      vpc,
      encrypted: true,
      securityGroup: fsSg,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    });

    props.games.forEach((g, i) => {
      if (!GAME_KEY_RE.test(g.gameKey)) throw new Error(`invalid gameKey ${g.gameKey}`);
      this.game(g.gameKey, i + 1, { vpc, cluster, taskSg, listener, fs, serverRepo, gatewayRepo, props });
    });
  }

  private game(
    key: string,
    priority: number,
    s: {
      vpc: ec2.IVpc;
      cluster: ecs.Cluster;
      taskSg: ec2.SecurityGroup;
      listener: elbv2.ApplicationListener;
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
        ],
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

    const task = new ecs.FargateTaskDefinition(scope, 'Task', {
      family: `doprava-${key}`,
      cpu: 1024,
      memoryLimitMiB: 2048,
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
      portMappings: [{ containerPort: 8080 }],
      environment: {
        GAME_KEY: key,
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
      healthCheckGracePeriod: Duration.seconds(180),
    });

    const tg = new elbv2.ApplicationTargetGroup(scope, 'Tg', {
      targetGroupName: `edm-${key}`,
      vpc: s.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/healthz', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(30),
      targets: [service.loadBalancerTarget({ containerName: 'gateway', containerPort: 8080 })],
    });
    s.listener.addTargetGroups(`Rule-${key}`, {
      priority,
      conditions: [elbv2.ListenerCondition.pathPatterns([`/g/${key}`, `/g/${key}/*`])],
      targetGroups: [tg],
    });
  }
}
