#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import games from '../games.json';
import { DopravaStack } from '../lib/doprava-stack';

const app = new cdk.App();
const ctx = (k: string): string => {
  const v = app.node.tryGetContext(k);
  if (!v) throw new Error(`missing context ${k} (cdk deploy -c ${k}=...)`);
  return v;
};

new DopravaStack(app, 'EdumiseDopravaStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-central-1' },
  description: 'EduMise Doprava — per-class OpenTTD game servers (Fargate + ALB + EFS)',
  games,
  imageTag: ctx('imageTag'),
  certificateArn: ctx('certificateArn'),
  adminPublicKey: ctx('adminPublicKey'),
  walletClientId: ctx('walletClientId'),
  walletBase: ctx('walletBase'),
});

app.synth();
