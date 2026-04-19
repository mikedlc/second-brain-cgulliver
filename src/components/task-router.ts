/**
 * Task Router Component
 * 
 * Formats and sends task emails to OmniFocus via Mail Drop.
 * 
 * Validates: Requirements 17, 18, 39
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Task email structure
export interface TaskEmail {
  subject: string;
  body: string;
}

// Task router configuration
export interface TaskRouterConfig {
  sesRegion: string;
  fromEmail: string;
  mailDropParam: string;
}

// Send result
export interface TaskSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// Slack source reference
export interface SlackSource {
  userId: string;
  channelId: string;
  messageTs: string;
}

// Options for task email formatting
export interface TaskEmailOptions {
  sbId?: string;
  repoPath?: string;
  projectSbId?: string;  // Linked project SB_ID for task-project linking
}

// AWS clients
const sesClient = new SESClient({});
const ssmClient = new SSMClient({});

// Cached Mail Drop email with TTL (FINDING-SEC-01)
let cachedMailDrop: string | null = null;
let mailDropCachedAt: number = 0;
const SECRET_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get OmniFocus Mail Drop email from SSM
 * Caches for 1 hour to support secret rotation without redeployment
 */
async function getMailDropEmail(paramName: string): Promise<string> {
  const now = Date.now();
  if (cachedMailDrop && (now - mailDropCachedAt) < SECRET_CACHE_TTL_MS) {
    return cachedMailDrop;
  }

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    })
  );

  if (!response.Parameter?.Value) {
    throw new Error('Mail Drop email not found in SSM');
  }

  cachedMailDrop = response.Parameter.Value;
  mailDropCachedAt = now;
  return cachedMailDrop;
}

/**
 * Format task email for OmniFocus Mail Drop
 * 
 * Validates: Requirements 18, 39, 7.1, 7.2
 * 
 * OmniFocus Mail Drop format:
 * - Subject becomes task title
 * - Body becomes task note
 * - Can include :: for project assignment
 * - Can include # for tags
 * - Can include // for due date
 * 
 * SB_ID Integration (R-MAILDROP-02, R-MAILDROP-04):
 * - Required: SB-ID: <SB_ID>
 * - Optional: SB-Source: maildrop
 * - Optional: SB-Repo-Path: <path>
 */
export function formatTaskEmail(
  taskTitle: string,
  context: string,
  slackSource: SlackSource,
  options?: TaskEmailOptions
): TaskEmail {
  // Ensure title is in imperative voice (basic check)
  let title = taskTitle.trim();
  
  // Remove leading "I need to" or similar phrases
  const prefixesToRemove = [
    /^i need to\s+/i,
    /^i should\s+/i,
    /^i have to\s+/i,
    /^i must\s+/i,
    /^need to\s+/i,
    /^should\s+/i,
    /^have to\s+/i,
    /^must\s+/i,
  ];

  for (const prefix of prefixesToRemove) {
    title = title.replace(prefix, '');
  }

  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // Build body with context and source reference
  const bodyLines: string[] = [];

  if (context) {
    bodyLines.push(context);
    bodyLines.push('');
  }

  bodyLines.push('---');
  
  // SB_ID integration (Validates: Requirements 7.1, 7.2)
  if (options?.sbId) {
    bodyLines.push(`SB-ID: ${options.sbId}`);
    bodyLines.push('SB-Source: maildrop');
    if (options.repoPath) {
      bodyLines.push(`SB-Repo-Path: ${options.repoPath}`);
    }
  }
  
  // Task-project linking (Validates: Requirements 6.1, 6.2)
  if (options?.projectSbId) {
    bodyLines.push(`SB-Project: ${options.projectSbId}`);
  }
  
  if (options?.sbId || options?.projectSbId) {
    bodyLines.push('');
  }
  
  bodyLines.push(`Source: Slack DM`);
  bodyLines.push(`User: ${slackSource.userId}`);
  bodyLines.push(`Timestamp: ${slackSource.messageTs}`);

  return {
    subject: title,
    body: bodyLines.join('\n'),
  };
}

/**
 * Send task email via SES
 * 
 * Validates: Requirements 17.1, 17.2
 */
export async function sendTaskEmail(
  config: TaskRouterConfig,
  email: TaskEmail
): Promise<TaskSendResult> {
  try {
    const mailDropEmail = await getMailDropEmail(config.mailDropParam);

    const response = await sesClient.send(
      new SendEmailCommand({
        Source: config.fromEmail,
        Destination: {
          ToAddresses: [mailDropEmail],
        },
        Message: {
          Subject: {
            Data: email.subject,
            Charset: 'UTF-8',
          },
          Body: {
            Text: {
              Data: email.body,
              Charset: 'UTF-8',
            },
          },
        },
      })
    );

    return {
      success: true,
      messageId: response.MessageId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clear cached Mail Drop email (for testing)
 */
export function clearMailDropCache(): void {
  cachedMailDrop = null;
}
