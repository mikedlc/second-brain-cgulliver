import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Security mode for Slack webhook ingress
 * 
 * - mtls-hmac: API Gateway with mTLS + HMAC signature verification (recommended)
 * - mtls-only: API Gateway with mTLS only, no HMAC verification
 * - hmac-only: Lambda Function URL with HMAC signature verification only
 */
export type IngressSecurityMode = 'mtls-hmac' | 'mtls-only' | 'hmac-only';

export interface IngressStackProps extends cdk.StackProps {
  /**
   * Security mode for the ingress endpoint
   * @default 'mtls-hmac'
   */
  securityMode?: IngressSecurityMode;
}

/**
 * Ingress Stack: Handles Slack webhook requests
 * 
 * Supports three security modes (configured via SSM parameter):
 * 
 * 1. mtls-hmac (default, most secure):
 *    - API Gateway HTTP API with custom domain
 *    - mTLS enabled - Slack presents client cert signed by DigiCert
 *    - HMAC signature verification in Lambda
 *    - Requires: domain_name, hosted_zone_id, acm_cert_arn, slack-signing-secret
 * 
 * 2. mtls-only:
 *    - API Gateway HTTP API with custom domain
 *    - mTLS enabled - Slack presents client cert signed by DigiCert
 *    - No HMAC verification (trusts mTLS authentication)
 *    - Requires: domain_name, hosted_zone_id, acm_cert_arn
 * 
 * 3. hmac-only:
 *    - Lambda Function URL (no API Gateway)
 *    - HMAC signature verification in Lambda
 *    - Simplest setup, no custom domain required
 *    - Requires: slack-signing-secret
 * 
 * Components:
 * - Lambda function for Slack webhook processing
 * - SQS Queue for async event processing
 * - SQS Dead Letter Queue for failed messages
 * - (mtls modes) API Gateway HTTP API with custom domain + mTLS
 * - (mtls modes) Route 53 DNS record for custom domain
 * - (mtls modes) S3 bucket for mTLS truststore (DigiCert CA bundle)
 * - (hmac-only) Lambda Function URL
 * 
 * Validates: Requirement 28, 28a (CDK Infrastructure + Security Delta)
 */
export class IngressStack extends cdk.Stack {
  /** SQS Queue for event processing - exported for Core Stack */
  public readonly queue: sqs.Queue;
  
  /** API Gateway HTTP API (only for mtls modes) */
  public readonly api?: apigwv2.HttpApi;
  
  /** Lambda Function URL (only for hmac-only mode) */
  public readonly functionUrl?: lambda.FunctionUrl;
  
  /** Ingress Lambda function */
  public readonly ingressFunction: lambda.Function;
  
  /** The security mode used for this deployment */
  public readonly securityMode: IngressSecurityMode;

  constructor(scope: Construct, id: string, props?: IngressStackProps) {
    super(scope, id, props);

    // =========================================================================
    // Determine Security Mode
    // =========================================================================
    
    // Security mode is passed via CDK context or props at synthesis time.
    // The SSM parameter /secondbrain/ingress/security_mode is used for
    // documentation and runtime reference, but CDK needs a concrete value
    // at synthesis time for conditional resource creation.
    this.securityMode = props?.securityMode ?? 'mtls-hmac';

    // =========================================================================
    // SSM Parameter References (conditional based on mode)
    // =========================================================================

    // Slack signing secret (required for mtls-hmac and hmac-only modes)
    const signingSecretParam = this.securityMode !== 'mtls-only'
      ? ssm.StringParameter.fromSecureStringParameterAttributes(
          this,
          'SlackSigningSecret',
          { parameterName: '/second-brain/slack-signing-secret' }
        )
      : undefined;

    // Domain configuration (required for mtls modes)
    const domainName = this.securityMode !== 'hmac-only'
      ? ssm.StringParameter.valueForStringParameter(this, '/secondbrain/ingress/domain_name')
      : undefined;
    
    const hostedZoneId = this.securityMode !== 'hmac-only'
      ? ssm.StringParameter.valueForStringParameter(this, '/secondbrain/ingress/hosted_zone_id')
      : undefined;
    
    const acmCertArn = this.securityMode !== 'hmac-only'
      ? ssm.StringParameter.valueForStringParameter(this, '/secondbrain/ingress/acm_cert_arn')
      : undefined;

    // =========================================================================
    // SQS Queue with DLQ
    // =========================================================================

    const dlq = new sqs.Queue(this, 'IngressDLQ', {
      queueName: 'second-brain-ingress-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'IngressQueue', {
      queueName: 'second-brain-ingress',
      visibilityTimeout: cdk.Duration.seconds(180), // Must be >= Worker Lambda timeout (120s)
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // =========================================================================
    // Ingress Lambda function
    // =========================================================================

    const lambdaEnvironment: Record<string, string> = {
      QUEUE_URL: this.queue.queueUrl,
      NODE_OPTIONS: '--enable-source-maps',
      SECURITY_MODE: this.securityMode,
      BOT_TOKEN_PARAM: '/second-brain/slack-bot-token', // For 👀 reaction on receipt
    };

    // Only include signing secret param if HMAC verification is enabled
    if (signingSecretParam) {
      lambdaEnvironment.SIGNING_SECRET_PARAM = signingSecretParam.parameterName;
    }

    this.ingressFunction = new lambdaNodejs.NodejsFunction(this, 'IngressFunction', {
      functionName: 'second-brain-ingress',
      description: `Slack webhook handler (${this.securityMode} mode)`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      entry: path.join(__dirname, '../src/handlers/ingress.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: [
          '@aws-sdk/client-sqs',
          '@aws-sdk/client-ssm',
        ],
      },
      environment: lambdaEnvironment,
    });

    this.queue.grantSendMessages(this.ingressFunction);
    
    if (signingSecretParam) {
      signingSecretParam.grantRead(this.ingressFunction);
    }

    // Grant read access to bot token for 👀 emoji reaction
    const botTokenParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'BotTokenForReaction',
      { parameterName: '/second-brain/slack-bot-token' }
    );
    botTokenParam.grantRead(this.ingressFunction);

    // =========================================================================
    // Mode-specific infrastructure
    // =========================================================================

    if (this.securityMode === 'hmac-only') {
      // HMAC-only mode: Lambda Function URL
      this.functionUrl = this.ingressFunction.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
        cors: {
          allowedOrigins: ['https://api.slack.com'],
          allowedMethods: [lambda.HttpMethod.POST],
          allowedHeaders: ['content-type', 'x-slack-signature', 'x-slack-request-timestamp'],
        },
      });

      new cdk.CfnOutput(this, 'WebhookUrl', {
        value: this.functionUrl.url,
        description: 'Slack webhook URL (Lambda Function URL)',
        exportName: 'SecondBrainSlackWebhookUrl',
      });

    } else {
      // mTLS modes: API Gateway with custom domain
      this.createMtlsInfrastructure(domainName!, hostedZoneId!, acmCertArn!);
    }

    // =========================================================================
    // Common Stack Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'QueueArn', {
      value: this.queue.queueArn,
      description: 'SQS Queue ARN for Core Stack',
      exportName: 'SecondBrainIngressQueueArn',
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: this.queue.queueUrl,
      description: 'SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'DLQArn', {
      value: dlq.queueArn,
      description: 'Dead Letter Queue ARN',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.ingressFunction.functionArn,
      description: 'Ingress Lambda Function ARN',
    });

    new cdk.CfnOutput(this, 'SecurityMode', {
      value: this.securityMode,
      description: 'Security mode: mtls-hmac, mtls-only, or hmac-only',
    });
  }

  /**
   * Create mTLS infrastructure (API Gateway, custom domain, Route 53, truststore)
   */
  private createMtlsInfrastructure(
    domainName: string,
    hostedZoneId: string,
    acmCertArn: string
  ): void {
    // =========================================================================
    // mTLS Truststore (DigiCert CA bundle for Slack client certificates)
    // =========================================================================

    const truststoreBucket = new s3.Bucket(this, 'TruststoreBucket', {
      bucketName: `second-brain-mtls-truststore-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true, // Required for mTLS truststore updates
    });

    // Deploy DigiCert CA bundle to S3
    const truststoreDeployment = new s3deploy.BucketDeployment(this, 'TruststoreDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../certs'))],
      destinationBucket: truststoreBucket,
      destinationKeyPrefix: 'truststore',
    });

    // =========================================================================
    // API Gateway with Custom Domain + mTLS
    // =========================================================================

    // Create custom domain with mTLS enabled
    const cfnDomainName = new apigwv2.CfnDomainName(this, 'CustomDomainCfn', {
      domainName: domainName,
      domainNameConfigurations: [
        {
          certificateArn: acmCertArn,
          endpointType: 'REGIONAL',
        },
      ],
      mutualTlsAuthentication: {
        truststoreUri: `s3://${truststoreBucket.bucketName}/truststore/digicert-root-ca.pem`,
      },
    });

    cfnDomainName.node.addDependency(truststoreDeployment);

    // Create HTTP API
    (this as { api: apigwv2.HttpApi }).api = new apigwv2.HttpApi(this, 'SlackIngressApi', {
      apiName: 'second-brain-slack-ingress',
      description: `Slack webhook ingress API (${this.securityMode} mode)`,
      disableExecuteApiEndpoint: true,
    });

    // Create API mapping to custom domain
    new apigwv2.CfnApiMapping(this, 'ApiMapping', {
      apiId: this.api!.apiId,
      domainName: domainName,
      stage: '$default',
    }).addDependency(cfnDomainName);

    // Add POST route for Slack webhooks
    this.api!.addRoutes({
      path: '/slack/events',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'SlackEventsIntegration',
        this.ingressFunction
      ),
    });

    // =========================================================================
    // Route 53 DNS Record
    // =========================================================================

    new route53.CfnRecordSet(this, 'ApiAliasRecord', {
      hostedZoneId: hostedZoneId,
      name: domainName,
      type: 'A',
      aliasTarget: {
        dnsName: cfnDomainName.attrRegionalDomainName,
        hostedZoneId: cfnDomainName.attrRegionalHostedZoneId,
      },
    });

    // =========================================================================
    // mTLS-specific Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `https://${domainName}/slack/events`,
      description: 'Slack webhook URL (API Gateway with mTLS)',
      exportName: 'SecondBrainSlackWebhookUrl',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api!.apiId,
      description: 'API Gateway HTTP API ID',
    });

    new cdk.CfnOutput(this, 'TruststoreBucketName', {
      value: truststoreBucket.bucketName,
      description: 'S3 bucket containing mTLS truststore',
    });
  }
}
