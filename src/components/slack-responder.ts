/**
 * Slack Responder Component
 * 
 * Formats and sends replies to Slack via Web API.
 * 
 * Validates: Requirements 37, 38
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Classification } from '../types';

// Slack reply structure
export interface SlackReply {
  channel: string;
  text: string;
  thread_ts?: string;
}

// Slack responder configuration
export interface SlackResponderConfig {
  botTokenParam: string;
}

// Send result
export interface SlackSendResult {
  success: boolean;
  ts?: string;
  error?: string;
}

// AWS clients
const ssmClient = new SSMClient({});

// Cached bot token with TTL (FINDING-SEC-01)
let cachedBotToken: string | null = null;
let botTokenCachedAt: number = 0;
const SECRET_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get Slack bot token from SSM
 * Caches for 1 hour to support secret rotation without redeployment
 */
async function getBotToken(paramName: string): Promise<string> {
  const now = Date.now();
  if (cachedBotToken && (now - botTokenCachedAt) < SECRET_CACHE_TTL_MS) {
    return cachedBotToken;
  }

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    })
  );

  if (!response.Parameter?.Value) {
    throw new Error('Bot token not found in SSM');
  }

  cachedBotToken = response.Parameter.Value;
  botTokenCachedAt = now;
  return cachedBotToken;
}

/**
 * Format confirmation reply for successful capture
 * 
 * Validates: Requirements 37.1, 37.2
 */
export function formatConfirmationReply(
  classification: Classification | 'fix' | 'clarify',
  files: string[],
  commitId: string | null,
  options?: {
    taskTitle?: string;
    emailSent?: boolean;
  }
): string {
  const lines: string[] = [];

  if (classification === 'task' && options?.emailSent) {
    lines.push(`Captured as *${classification}*`);
    if (options.taskTitle) {
      lines.push(`Task sent to OmniFocus: "${options.taskTitle}"`);
    } else {
      lines.push('Task sent to OmniFocus');
    }
    // No fix hint for tasks - they're emails, not commits
  } else if (classification === 'fix') {
    lines.push('Fix applied successfully');
    if (files.length > 0) {
      lines.push(`Files: ${files.join(', ')}`);
    }
    if (commitId) {
      lines.push(`Commit: \`${commitId.substring(0, 7)}\``);
    }
    lines.push('');
    lines.push('Reply `fix: <instruction>` to correct.');
  } else {
    lines.push(`Captured as *${classification}*`);

    if (files.length > 0) {
      lines.push(`Files: ${files.join(', ')}`);
    }

    if (commitId) {
      lines.push(`Commit: \`${commitId.substring(0, 7)}\``);
    }

    lines.push('');
    lines.push('Reply `fix: <instruction>` to correct.');
  }

  return lines.join('\n');
}

/**
 * Format clarification reply when confidence is low
 * 
 * Validates: Requirements 38.1, 38.2, 38.3
 */
export function formatClarificationReply(
  question: string,
  options: string[]
): string {
  const lines: string[] = [question, ''];

  const descriptions: Record<string, string> = {
    inbox: 'a quick note or observation',
    idea: 'a conceptual insight or observation',
    decision: 'a commitment you\'ve made',
    project: 'a multi-step initiative',
    task: 'something you need to do',
  };

  for (const opt of options) {
    const desc = descriptions[opt] || opt;
    lines.push(`• *${opt}* — ${desc}`);
  }

  lines.push('');
  lines.push('Or reply `reclassify: <type>` to specify directly.');

  return lines.join('\n');
}

/**
 * Format error reply
 */
export function formatErrorReply(
  error: string,
  details?: string[]
): string {
  const lines = ["I couldn't process that message. Please try rephrasing."];

  if (details && details.length > 0) {
    lines.push('');
    lines.push(`Errors: ${details.join(', ')}`);
  } else if (error) {
    lines.push('');
    lines.push(`Error: ${error}`);
  }

  return lines.join('\n');
}

/**
 * Send reply to Slack via Web API
 * 
 * Validates: Requirements 37, 38
 */
export async function sendSlackReply(
  config: SlackResponderConfig,
  reply: SlackReply
): Promise<SlackSendResult> {
  try {
    const botToken = await getBotToken(config.botTokenParam);

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: reply.channel,
        text: reply.text,
        thread_ts: reply.thread_ts,
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      ts?: string;
      error?: string;
    };

    if (!data.ok) {
      return {
        success: false,
        error: data.error || 'Unknown Slack API error',
      };
    }

    return {
      success: true,
      ts: data.ts,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clear cached bot token (for testing)
 */
export function clearBotTokenCache(): void {
  cachedBotToken = null;
}

/**
 * Format task confirmation with optional project link
 * 
 * Validates: Requirements 7.1, 7.2, 7.3 (task-project-linking)
 */
export function formatTaskConfirmation(
  taskTitle: string,
  linkedProject?: { title: string; sbId: string }
): string {
  if (linkedProject) {
    return `Task sent to OmniFocus, linked to project: ${linkedProject.title} (${linkedProject.sbId})`;
  }
  return `Task sent to OmniFocus: "${taskTitle}"`;
}
