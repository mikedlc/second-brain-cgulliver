/**
 * Conversation Session Store
 *
 * Manages conversation session state in DynamoDB for the "discuss" interaction mode.
 * Sessions track multi-turn conversations with a 4-hour TTL.
 *
 * Validates: Requirements 13.5, 13.9, 13.18
 */

import { randomBytes } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ConversationSession, SessionMessage } from '../types/conversation-session';

/** Default session timeout: 4 hours in seconds */
const DEFAULT_SESSION_TIMEOUT_SECONDS = 14400;

/** DynamoDB client */
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

/** Session store configuration */
export interface SessionStoreConfig {
  tableName: string;
  timeoutSeconds?: number;
}

/**
 * Generate a unique discussion ID in the format ds-{7 hex chars}
 */
export function generateDiscussionId(): string {
  return `ds-${randomBytes(4).toString('hex').slice(0, 7)}`;
}

/**
 * Build a session ID from channel and user IDs.
 * Format: {channelId}#{userId}
 */
export function buildSessionId(channelId: string, userId: string): string {
  return `${channelId}#${userId}`;
}

/**
 * Create a new conversation session in DynamoDB.
 *
 * Validates: Requirement 13.5
 */
export async function createSession(
  config: SessionStoreConfig,
  channelId: string,
  userId: string,
  topic: string,
  relatedArea: string
): Promise<ConversationSession> {
  const now = new Date().toISOString();
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + timeoutSeconds;

  const session: ConversationSession = {
    session_id: buildSessionId(channelId, userId),
    discussion_id: generateDiscussionId(),
    topic,
    related_area: relatedArea,
    messages: [],
    status: 'active',
    created_at: now,
    last_active_at: now,
    message_count: 0,
    expires_at: expiresAt,
  };

  await docClient.send(
    new PutCommand({
      TableName: config.tableName,
      Item: session,
    })
  );

  return session;
}

/**
 * Append a message to an existing session.
 * Extends TTL, increments message_count, and updates last_active_at.
 *
 * Validates: Requirements 13.5, 13.9
 */
export async function appendMessage(
  config: SessionStoreConfig,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const now = new Date().toISOString();
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + timeoutSeconds;

  const message: SessionMessage = {
    role,
    content,
    timestamp: now,
  };

  await docClient.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { session_id: sessionId },
      UpdateExpression:
        'SET messages = list_append(messages, :msg), ' +
        'message_count = message_count + :one, ' +
        'last_active_at = :now, ' +
        'expires_at = :ttl',
      ExpressionAttributeValues: {
        ':msg': [message],
        ':one': 1,
        ':now': now,
        ':ttl': expiresAt,
      },
    })
  );
}

/**
 * Get the active session for a channel/user pair.
 * Returns null if no active session exists or if the session has expired.
 *
 * Validates: Requirement 13.5
 */
export async function getActiveSession(
  config: SessionStoreConfig,
  channelId: string,
  userId: string
): Promise<ConversationSession | null> {
  const sessionId = buildSessionId(channelId, userId);

  const result = await docClient.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { session_id: sessionId },
    })
  );

  if (!result.Item) {
    return null;
  }

  const session = result.Item as ConversationSession;

  // Check if session is active and not expired
  const now = Math.floor(Date.now() / 1000);
  if (session.status !== 'active' || session.expires_at < now) {
    return null;
  }

  return session;
}

/**
 * Mark a session as filed.
 *
 * Validates: Requirement 13.5
 */
export async function markSessionFiled(
  config: SessionStoreConfig,
  sessionId: string
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { session_id: sessionId },
      UpdateExpression: 'SET #s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': 'filed' },
    })
  );
}

/**
 * Mark a session as discarded.
 *
 * Validates: Requirement 13.5
 */
export async function markSessionDiscarded(
  config: SessionStoreConfig,
  sessionId: string
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { session_id: sessionId },
      UpdateExpression: 'SET #s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': 'discarded' },
    })
  );
}
