#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IngressStack, IngressSecurityMode } from '../lib/ingress-stack';
import { CoreStack } from '../lib/core-stack';

const app = new cdk.App();

// =========================================================================
// Resource Tagging
// Tags applied at the app level propagate to ALL resources in ALL stacks.
// This ensures every resource can be identified, cost-allocated, and
// cleaned up reliably in a shared account.
// =========================================================================
cdk.Tags.of(app).add('Project', 'second-brain');
cdk.Tags.of(app).add('ManagedBy', 'cdk');
cdk.Tags.of(app).add('Repository', 'mikedlc/aws-agentcore-second-brain');
cdk.Tags.of(app).add('Environment', 'production');

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Get security mode from CDK context (default: mtls-hmac)
// Usage: cdk deploy -c securityMode=hmac-only
const securityMode = app.node.tryGetContext('securityMode') as IngressSecurityMode | undefined;

// Validate security mode if provided
const validModes: IngressSecurityMode[] = ['mtls-hmac', 'mtls-only', 'hmac-only'];
if (securityMode && !validModes.includes(securityMode)) {
  throw new Error(
    `Invalid securityMode: ${securityMode}. Valid options: ${validModes.join(', ')}`
  );
}

// Ingress Stack: Slack webhook endpoint + SQS Queue
const ingressStack = new IngressStack(app, 'SecondBrainIngressStack', {
  env,
  description: `Second Brain Agent - Ingress (${securityMode ?? 'mtls-hmac'} mode)`,
  securityMode,
});

// Core Stack: Worker Lambda + CodeCommit + DynamoDB + SES + AgentCore
const coreStack = new CoreStack(app, 'SecondBrainCoreStack', {
  env,
  description: 'Second Brain Agent - Core (Worker, CodeCommit, DynamoDB, SES, AgentCore)',
  ingressQueue: ingressStack.queue,
});

// Ensure Core Stack deploys after Ingress Stack
coreStack.addDependency(ingressStack);

app.synth();
