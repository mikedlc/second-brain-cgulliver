/**
 * Conversation Session Types
 *
 * Defines types for the "discuss" interaction mode, including session state
 * stored in DynamoDB and draft files persisted to CodeCommit.
 *
 * Validates: Requirements 13.5, 13.9, 13.12, 13.13, 13.18
 */

/**
 * Session status values
 */
export type SessionStatus = 'active' | 'filed' | 'discarded' | 'timed_out';

/**
 * A single message within a conversation session
 */
export interface SessionMessage {
  /** Role of the message sender */
  role: 'user' | 'assistant';
  /** Message content */
  content: string;
  /** ISO-8601 timestamp */
  timestamp: string;
}

/**
 * Conversation session stored in DynamoDB
 *
 * Validates: Requirements 13.5, 13.9, 13.18
 */
export interface ConversationSession {
  /** Partition key: {channel_id}#{user_id} */
  session_id: string;
  /** Unique discussion session ID (e.g., "ds-a7f3c2d") */
  discussion_id: string;
  /** Topic of the conversation */
  topic: string;
  /** Related area in the knowledge base (e.g., "25_Real_Estate") */
  related_area: string;
  /** Message history */
  messages: SessionMessage[];
  /** Session status */
  status: SessionStatus;
  /** Creation timestamp (ISO-8601) */
  created_at: string;
  /** Last activity timestamp (ISO-8601) */
  last_active_at: string;
  /** Total message count */
  message_count: number;
  /** TTL for DynamoDB expiry (Unix timestamp) */
  expires_at: number;
}

/**
 * Front matter fields for a draft file persisted to 00_System/Pending/
 *
 * Validates: Requirements 13.12, 13.13
 */
export interface DraftFrontMatter {
  /** Unique session ID (e.g., "ds-a7f3c2d") */
  session_id: string;
  /** Conversation topic */
  topic: string;
  /** Related knowledge area */
  related_area: string;
  /** Draft status — always "open" for pending drafts */
  status: 'open';
  /** Creation timestamp (ISO-8601) */
  created_at: string;
  /** Last activity timestamp (ISO-8601) */
  last_active_at: string;
  /** Total message count */
  message_count: number;
}

/**
 * Draft file persisted to 00_System/Pending/ on session timeout or proactively
 *
 * Validates: Requirements 13.12, 13.13
 */
export interface DraftFile {
  /** Front matter fields */
  frontMatter: DraftFrontMatter;
  /** File path: 00_System/Pending/YYYY-MM-DD__<topic-slug>__<session_id>.md */
  path: string;
  /** Content: conversation transcript + bot summary */
  content: string;
}
