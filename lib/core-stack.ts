import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CoreStackProps extends cdk.StackProps {
  /** SQS Queue from Ingress Stack */
  ingressQueue: sqs.IQueue;
}

/**
 * Core Stack: Main processing infrastructure
 * 
 * Components:
 * - Worker Lambda (SQS event source)
 * - DynamoDB Tables (idempotency, conversation context)
 * - CodeCommit Repository (knowledge store)
 * - SES Email Identity
 * - AgentCore Runtime (ECR + CodeBuild + CfnRuntime)
 * 
 * Validates: Requirement 28 (CDK Infrastructure)
 */
export class CoreStack extends cdk.Stack {
  /** DynamoDB table for idempotency tracking */
  public readonly idempotencyTable: dynamodb.Table;
  
  /** DynamoDB table for conversation context */
  public readonly conversationTable: dynamodb.Table;
  
  /** CodeCommit repository for knowledge storage */
  public readonly repository: codecommit.Repository;

  /** ECR repository for classifier agent */
  public readonly ecrRepository: ecr.IRepository;

  /** Worker Lambda function */
  public readonly workerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);

    // =========================================================================
    // Task 3.1: DynamoDB Idempotency Table
    // Validates: Requirements 21, 24a
    // =========================================================================
    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: 'second-brain-idempotency',
      partitionKey: {
        name: 'event_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================================
    // Task 3.2: DynamoDB Conversation Context Table
    // Validates: Requirements 9.1, 9.3
    // =========================================================================
    this.conversationTable = new dynamodb.Table(this, 'ConversationTable', {
      tableName: 'second-brain-conversations',
      partitionKey: {
        name: 'session_id', // Format: {channel_id}#{user_id}
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================================
    // Task 3.3: CodeCommit Repository
    // Validates: Requirements 11, 29, 40
    // =========================================================================
    this.repository = new codecommit.Repository(this, 'KnowledgeRepository', {
      repositoryName: 'second-brain-knowledge',
      description: 'Second Brain knowledge store (Markdown + receipts)',
    });

    // =========================================================================
    // Task 3.4: System Prompt Bootstrap Custom Resource
    // Validates: Requirements 29, 40
    // =========================================================================
    const bootstrapFunction = new lambdaNodejs.NodejsFunction(this, 'BootstrapFunction', {
      functionName: 'second-brain-bootstrap',
      description: 'Bootstrap CodeCommit repository with folder structure and system prompt',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.minutes(2),
      entry: path.join(__dirname, '../src/handlers/bootstrap.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/client-codecommit'],
      },
      environment: {
        REPOSITORY_NAME: this.repository.repositoryName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // Grant bootstrap function permission to read/write CodeCommit
    this.repository.grantPullPush(bootstrapFunction);
    // Additional permissions needed for bootstrap (GetBranch, CreateCommit, GetFile)
    bootstrapFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'codecommit:GetBranch',
          'codecommit:CreateCommit',
          'codecommit:GetFile',
        ],
        resources: [this.repository.repositoryArn],
      })
    );

    // Custom resource to trigger bootstrap on first deploy
    const bootstrapProvider = new cr.Provider(this, 'BootstrapProvider', {
      onEventHandler: bootstrapFunction,
      logGroup: new logs.LogGroup(this, 'BootstrapProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    new cdk.CustomResource(this, 'BootstrapResource', {
      serviceToken: bootstrapProvider.serviceToken,
      properties: {
        // Trigger on repository name change
        RepositoryName: this.repository.repositoryName,
      },
    });

    // =========================================================================
    // Task 3.5: ECR Repository for AgentCore Classifier
    // Validates: Requirements 6.3, 28
    // =========================================================================
    // Import existing ECR repository (created manually for initial image push)
    this.ecrRepository = ecr.Repository.fromRepositoryName(
      this,
      'ClassifierRepository',
      'second-brain-classifier'
    );


    // =========================================================================
    // Task 3.6: CodeBuild Project for Classifier Container
    // Validates: Requirements 6.3, 28
    // =========================================================================
    
    // S3 Asset for agent source code
    const agentSourceAsset = new s3Assets.Asset(this, 'AgentSourceAsset', {
      path: path.join(__dirname, '../agent'),
    });

    // CodeBuild role with ECR and S3 permissions
    const codeBuildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        CodeBuildPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CloudWatchLogs',
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`],
            }),
            // FINDING-IAM-04: Split ECR permissions — GetAuthorizationToken requires '*',
            // other actions scoped to specific repository
            new iam.PolicyStatement({
              sid: 'ECRAuth',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:GetAuthorizationToken',
              ],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'ECRAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
              ],
              resources: [this.ecrRepository.repositoryArn],
            }),
            new iam.PolicyStatement({
              sid: 'S3SourceAccess',
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:GetObjectVersion'],
              resources: [`${agentSourceAsset.bucket.bucketArn}/*`],
            }),
          ],
        }),
      },
    });

    // CodeBuild project for ARM64 Docker image
    const buildProject = new codebuild.Project(this, 'ClassifierBuildProject', {
      projectName: 'second-brain-classifier-build',
      description: 'Build classifier agent Docker image for AgentCore Runtime',
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true, // Required for Docker builds
      },
      source: codebuild.Source.s3({
        bucket: agentSourceAsset.bucket,
        path: agentSourceAsset.s3ObjectKey,
      }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building the Docker image for classifier agent ARM64...',
              'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
              'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
            ],
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker image...',
              'docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
              'echo ARM64 Docker image pushed successfully',
            ],
          },
        },
      }),
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        AWS_ACCOUNT_ID: { value: this.account },
        IMAGE_REPO_NAME: { value: this.ecrRepository.repositoryName },
        IMAGE_TAG: { value: 'latest' },
      },
    });

    // =========================================================================
    // Task 3.7: AgentCore Runtime Resource
    // Validates: Requirements 6.3, 28
    // =========================================================================

    // Classifier Model Selection
    // Default: Nova 2 Lite - best balance of cost, quality, and 1M context window
    // Options: amazon.nova-micro-v1:0, amazon.nova-lite-v1:0, anthropic.claude-3-5-haiku-20241022-v1:0
    // Nova 2: global.amazon.nova-2-lite-v1:0 (supports extended thinking)
    const classifierModel = this.node.tryGetContext('classifierModel') || 'global.amazon.nova-2-lite-v1:0';
    
    // Nova 2 Extended Thinking (reasoning) configuration
    // Options: disabled (default), low, medium, high
    // Only applies to Nova 2 models (nova-2-lite, nova-2-omni)
    const reasoningEffort = this.node.tryGetContext('reasoningEffort') || 'disabled';

    // IAM role for AgentCore execution
    const agentCoreRole = new iam.Role(this, 'AgentCoreRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      inlinePolicies: {
        AgentCorePolicy: new iam.PolicyDocument({
          statements: [
            // ECR permissions for pulling container image
            new iam.PolicyStatement({
              sid: 'ECRAuth',
              effect: iam.Effect.ALLOW,
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'ECRPull',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:BatchGetImage',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchCheckLayerAvailability',
              ],
              resources: [this.ecrRepository.repositoryArn],
            }),
            // Bedrock model invocation (scoped to configured model)
            // FINDING-IAM-03: Replaced resources: ['*'] with specific model ARNs
            // Note: global.* models use inference-profile ARNs, others use foundation-model ARNs
            new iam.PolicyStatement({
              sid: 'BedrockInvoke',
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
              ],
              resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/${classifierModel}`,
                `arn:aws:bedrock:us-east-1::foundation-model/${classifierModel}`,
                `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${classifierModel}`,
                `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/${classifierModel}`,
              ],
            }),
            // CloudWatch Logs
            new iam.PolicyStatement({
              sid: 'CloudWatchLogs',
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`],
            }),
          ],
        }),
      },
    });

    // =========================================================================
    // Task 31.1: AgentCore Memory Resource (v2 - Behavioral Learning)
    // Validates: Requirements 58.1, 58.2
    // =========================================================================

    // AgentCore Memory for behavioral learning (user preferences, patterns)
    // and item metadata for cross-linking
    // Note: Only one strategy of each type is allowed, and each strategy can only have ONE namespace
    // We use /patterns/{actorId} for both learned patterns AND synced item metadata
    const agentMemory = new cdk.CfnResource(this, 'AgentMemory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: 'second_brain_memory_v2',
        Description: 'Memory for Second Brain agent - stores user preferences, learned patterns, and item metadata',
        EventExpiryDuration: 30, // days
        MemoryStrategies: [
          {
            UserPreferenceMemoryStrategy: {
              Name: 'PreferenceLearner',
              Namespaces: ['/preferences/{actorId}'],
            },
          },
          {
            SemanticMemoryStrategy: {
              Name: 'SemanticExtractor',
              // Single namespace for both learned patterns and synced item metadata
              Namespaces: ['/patterns/{actorId}'],
            },
          },
        ],
      },
    });

    // Grant AgentCore role permissions for Memory operations (Task 31.4)
    // Including batch operations for direct item storage (bypasses strategy processing)
    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreMemory',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetMemory',
          'bedrock-agentcore:CreateMemoryRecord',
          'bedrock-agentcore:SearchMemoryRecords',
          'bedrock-agentcore:DeleteMemoryRecord',
          'bedrock-agentcore:BatchCreateMemoryRecords',
          'bedrock-agentcore:BatchDeleteMemoryRecords',
          'bedrock-agentcore:BatchUpdateMemoryRecords',
          'bedrock-agentcore:ListMemoryRecords',
          'bedrock-agentcore:RetrieveMemoryRecords',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`,
        ],
      })
    );

    // Grant AgentCore role SSM access for sync marker (delta sync)
    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncMarkerSSM',
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameter',
          'ssm:PutParameter',
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/second-brain/last-sync-commit`,
        ],
      })
    );

    // Grant AgentCore role read access to CodeCommit for use_aws tool
    // This allows the classifier to read projects folder to match implicit references
    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CodeCommitRead',
        effect: iam.Effect.ALLOW,
        actions: [
          'codecommit:GetFile',
          'codecommit:GetFolder',
          'codecommit:GetBranch',
          'codecommit:ListRepositories',
          'codecommit:BatchGetRepositories',
        ],
        resources: [this.repository.repositoryArn],
      })
    );

    // =========================================================================
    // Task 11.1: Sync Lambda for Memory-Repo Synchronization
    // Validates: Requirements 1.1, 2.1, 3.1, 5.1 (Memory-Repo Sync)
    // =========================================================================
    
    // SSM Parameter for sync marker (used by AgentCore runtime for delta sync)
    const syncMarkerParam = new ssm.StringParameter(this, 'SyncMarkerParam', {
      parameterName: '/second-brain/last-sync-commit',
      description: 'Last CodeCommit commit ID synced to Memory (for delta sync)',
      stringValue: 'initial', // Will be updated by sync process
      tier: ssm.ParameterTier.STANDARD,
    });

    // AgentCore Runtime (CfnRuntime)
    // Note: Using L1 construct as L2 may not be available yet
    // Task 31.2: Pass MEMORY_ID to Runtime via environment variable
    // Include source hash in description to force Runtime update on code changes
    const buildTimestamp = new Date().toISOString().substring(0, 16);
    const agentRuntime = new cdk.CfnResource(this, 'ClassifierRuntime', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: 'second_brain_classifier',
        Description: `Second Brain classifier agent (build: ${agentSourceAsset.assetHash.substring(0, 8)}, ts: ${buildTimestamp})`,
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: `${this.ecrRepository.repositoryUri}:latest`,
          },
        },
        NetworkConfiguration: {
          NetworkMode: 'PUBLIC',
        },
        ProtocolConfiguration: 'HTTP',
        RoleArn: agentCoreRole.roleArn,
        EnvironmentVariables: {
          KNOWLEDGE_REPO_NAME: this.repository.repositoryName,
          AWS_DEFAULT_REGION: this.region,
          MEMORY_ID: agentMemory.getAtt('MemoryId').toString(),
          MODEL_ID: classifierModel,
          REASONING_EFFORT: reasoningEffort,
          SYNC_MARKER_PARAM: syncMarkerParam.parameterName,
        },
      },
    });

    // Runtime depends on Memory being created first
    agentRuntime.node.addDependency(agentMemory);

    // =========================================================================
    // Task 3.8: Build Trigger Custom Resource
    // Validates: Requirements 6.3, 28
    // =========================================================================

    // Lambda function to trigger CodeBuild and wait for completion
    const buildTriggerFunction = new lambdaNodejs.NodejsFunction(this, 'BuildTriggerFunction', {
      functionName: 'second-brain-build-trigger',
      description: 'Trigger CodeBuild and wait for completion',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.minutes(15),
      entry: path.join(__dirname, '../src/handlers/build-trigger.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/client-codebuild'],
      },
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // Grant build trigger function permission to start and monitor builds
    buildTriggerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [buildProject.projectArn],
      })
    );

    // Custom resource provider for build trigger
    const buildTriggerProvider = new cr.Provider(this, 'BuildTriggerProvider', {
      onEventHandler: buildTriggerFunction,
      logGroup: new logs.LogGroup(this, 'BuildTriggerProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const triggerBuild = new cdk.CustomResource(this, 'TriggerBuild', {
      serviceToken: buildTriggerProvider.serviceToken,
      properties: {
        ProjectName: buildProject.projectName,
        // Force rebuild when agent source changes
        SourceHash: agentSourceAsset.assetHash,
      },
    });

    // AgentCore Runtime depends on successful build
    agentRuntime.node.addDependency(triggerBuild);

    // =========================================================================
    // Task 3.11: SES Email Identity
    // Validates: Requirements 17, 28, 52
    // =========================================================================
    
    // Note: SES email identity is managed outside CDK (verified manually)
    // The sender email is stored in SSM Parameter Store
    const senderEmailParam = ssm.StringParameter.fromStringParameterName(
      this,
      'SenderEmailParam',
      '/second-brain/ses-from-email'
    );

    // =========================================================================
    // Task 3.12: SSM Parameter for Conversation Context TTL
    // Validates: Requirements 9.5, 9.6, 9.7
    // =========================================================================
    
    const conversationTtlParam = new ssm.StringParameter(this, 'ConversationTtlParam', {
      parameterName: '/second-brain/conversation-ttl-seconds',
      description: 'TTL for conversation context records in seconds (default: 3600 = 1 hour)',
      stringValue: '3600',
      tier: ssm.ParameterTier.STANDARD,
    });

    // =========================================================================
    // SSM Parameter References (must be created manually before deploy)
    // =========================================================================
    
    const botTokenParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'SlackBotToken',
      { parameterName: '/second-brain/slack-bot-token' }
    );

    const mailDropParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'OmniFocusMailDrop',
      { parameterName: '/second-brain/omnifocus-maildrop-email' }
    );

    // =========================================================================
    // Task 3.9: Worker Lambda Function
    // Validates: Requirements 3, 28
    // =========================================================================
    
    this.workerFunction = new lambdaNodejs.NodejsFunction(this, 'WorkerFunction', {
      functionName: 'second-brain-worker',
      description: 'Process Slack events - classify, store, route tasks, reply',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120), // AgentCore + Nova 2 Lite may take time
      entry: path.join(__dirname, '../src/handlers/worker.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
          '@aws-sdk/client-codecommit',
          '@aws-sdk/client-ses',
          '@aws-sdk/client-ssm',
          '@aws-sdk/client-bedrock-agent-runtime',
        ],
      },
      environment: {
        REPOSITORY_NAME: this.repository.repositoryName,
        IDEMPOTENCY_TABLE: this.idempotencyTable.tableName,
        CONVERSATION_TABLE: this.conversationTable.tableName,
        AGENT_RUNTIME_ARN: agentRuntime.getAtt('AgentRuntimeArn').toString(),
        BOT_TOKEN_PARAM: botTokenParam.parameterName,
        MAILDROP_PARAM: mailDropParam.parameterName,
        CONVERSATION_TTL_PARAM: conversationTtlParam.parameterName,
        SES_FROM_EMAIL: senderEmailParam.stringValue,
        EMAIL_MODE: 'log', // Log mode - tasks classified but not emailed (no task manager configured)
        NODE_OPTIONS: '--enable-source-maps',
        DEPLOY_VERSION: '69', // Fix retrieve_memories API response format
        // Note: Sync operations now use AgentCore classifier (AGENT_RUNTIME_ARN)
        // instead of separate sync Lambda
      },
    });

    // Add SQS event source from Ingress queue
    this.workerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(props.ingressQueue, {
        batchSize: 1, // Process one event at a time for simplicity
        maxBatchingWindow: cdk.Duration.seconds(0),
        reportBatchItemFailures: true,
      })
    );

    // =========================================================================
    // Task 3.10: Worker Lambda Permissions
    // Validates: Requirements 23, 25
    // =========================================================================

    // DynamoDB permissions
    this.idempotencyTable.grantReadWriteData(this.workerFunction);
    this.conversationTable.grantReadWriteData(this.workerFunction);

    // CodeCommit permissions
    this.repository.grantPullPush(this.workerFunction);
    // Also need GetFile for reading system prompt
    this.workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'codecommit:GetFile',
          'codecommit:GetFolder',
          'codecommit:GetBranch',
          'codecommit:CreateCommit',
          'codecommit:GetCommit',
        ],
        resources: [this.repository.repositoryArn],
      })
    );

    // SSM permissions
    botTokenParam.grantRead(this.workerFunction);
    mailDropParam.grantRead(this.workerFunction);
    conversationTtlParam.grantRead(this.workerFunction);

    // SES send email permission (scoped to account SES identities)
    // FINDING-IAM-01: Replaced resources: ['*'] with account-scoped SES identity ARN
    this.workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/*`,
        ],
      })
    );

    // AgentCore invoke permission (scoped to specific runtime)
    // FINDING-IAM-02: Removed wildcard runtime/* resource
    // Note: InvokeAgentRuntime requires access to both the runtime ARN and its endpoint sub-resource
    this.workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeForUser',
        ],
        resources: [
          agentRuntime.getAtt('AgentRuntimeArn').toString(),
          `${agentRuntime.getAtt('AgentRuntimeArn').toString()}/*`,
        ],
      })
    );

    // CloudWatch metrics permission
    this.workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'SecondBrain',
          },
        },
      })
    );

    // =========================================================================
    // FINDING-COST-01: CloudWatch Alarms for cost and error monitoring
    // =========================================================================

    // SNS topic for alarm notifications
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'second-brain-alarms',
      displayName: 'Second Brain Alarms',
    });

    // Email subscription for alarm notifications
    alarmTopic.addSubscription(
      new snsSubscriptions.EmailSubscription('mikedlc@gmail.com')
    );

    // Alarm: Worker Lambda errors (>5 per hour)
    const workerErrorAlarm = new cloudwatch.Alarm(this, 'WorkerErrorAlarm', {
      alarmName: 'SecondBrain-WorkerErrors',
      alarmDescription: 'Worker Lambda error rate exceeds 5 per hour',
      metric: this.workerFunction.metricErrors({
        period: cdk.Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    workerErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: Worker Lambda invocations (>1000 per day — potential runaway cost)
    const workerInvocationAlarm = new cloudwatch.Alarm(this, 'WorkerInvocationAlarm', {
      alarmName: 'SecondBrain-HighInvocations',
      alarmDescription: 'Worker Lambda invocations exceed 1000/day — check for webhook spam or misconfiguration',
      metric: this.workerFunction.metricInvocations({
        period: cdk.Duration.days(1),
        statistic: 'Sum',
      }),
      threshold: 1000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    workerInvocationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: SQS DLQ has messages (failed processing)
    // Note: DLQ metric referenced by known queue name since IQueue doesn't expose deadLetterQueue
    const dlqMetric = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: {
        QueueName: 'second-brain-ingress-dlq',
      },
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    });

    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      alarmName: 'SecondBrain-DLQMessages',
      alarmDescription: 'Messages in Dead Letter Queue — processing failures detected',
      metric: dlqMetric,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: Worker Lambda throttles (capacity issues)
    const workerThrottleAlarm = new cloudwatch.Alarm(this, 'WorkerThrottleAlarm', {
      alarmName: 'SecondBrain-WorkerThrottles',
      alarmDescription: 'Worker Lambda is being throttled',
      metric: this.workerFunction.metricThrottles({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    workerThrottleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // =========================================================================
    // Stack Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS Topic ARN for alarm notifications — subscribe your email after deploy',
    });

    new cdk.CfnOutput(this, 'IdempotencyTableName', {
      value: this.idempotencyTable.tableName,
      description: 'DynamoDB Idempotency Table Name',
    });

    new cdk.CfnOutput(this, 'ConversationTableName', {
      value: this.conversationTable.tableName,
      description: 'DynamoDB Conversation Context Table Name',
    });

    new cdk.CfnOutput(this, 'RepositoryCloneUrl', {
      value: this.repository.repositoryCloneUrlHttp,
      description: 'CodeCommit Repository Clone URL (HTTPS)',
    });

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: this.repository.repositoryArn,
      description: 'CodeCommit Repository ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR Repository URI for classifier agent',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agentRuntime.getAtt('AgentRuntimeArn').toString(),
      description: 'AgentCore Runtime ARN',
    });

    new cdk.CfnOutput(this, 'AgentMemoryId', {
      value: agentMemory.getAtt('MemoryId').toString(),
      description: 'AgentCore Memory ID for behavioral learning',
    });

    new cdk.CfnOutput(this, 'WorkerFunctionArn', {
      value: this.workerFunction.functionArn,
      description: 'Worker Lambda Function ARN',
    });

    new cdk.CfnOutput(this, 'ClassifierModelId', {
      value: classifierModel,
      description: 'Bedrock model ID used for classification',
    });

    new cdk.CfnOutput(this, 'ReasoningEffort', {
      value: reasoningEffort,
      description: 'Nova 2 extended thinking effort level (disabled, low, medium, high)',
    });
  }
}
