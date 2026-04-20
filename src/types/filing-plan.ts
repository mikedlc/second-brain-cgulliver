/**
 * Filing Plan Types and Interfaces
 *
 * Defines the contract between the Classifier and Worker for organic knowledge filing.
 * Replaces the legacy ActionPlan with organic hierarchical filing operations.
 *
 * Validates: Requirements 1.1, 2.1, 4.1, 4.2, 4.3, 4.7, 4.8
 */

/**
 * Intent types — extended with "discuss" for conversational mode
 * Validates: Requirement 4.2
 */
export type FilingIntent = 'capture' | 'query' | 'status_update' | 'discuss';

/**
 * Integration actions — the five operations the Worker can perform
 * Validates: Requirement 2.1
 */
export type IntegrationAction = 'create' | 'append' | 'update' | 'delete' | 'move';

/**
 * How new content relates to existing material
 */
export type ContentDisposition =
  | 'new_topic'
  | 'continuation'
  | 'supersedes'
  | 'contradicts'
  | 'refines';

/**
 * Integration metadata — how new content relates to existing material
 * Validates: Requirement 4.4
 */
export interface IntegrationMetadata {
  /** Paths to related files for cross-referencing */
  related_files: string[];
  /** How the content relates to existing material */
  content_disposition: ContentDisposition;
  /** Classifier's confidence in the filing decision (0.0-1.0) */
  confidence: number;
}

/**
 * Linked item reference for cross-item linking
 */
export interface FilingLinkedItem {
  /** SB_ID of the linked item (e.g., "sb-a7f3c2d") */
  sb_id: string;
  /** Human-readable title of the linked item */
  title: string;
  /** Confidence score for the link match (0.0 to 1.0) */
  confidence: number;
}

/**
 * Filing Plan — the complete contract between Classifier and Worker
 *
 * Validates: Requirements 1.1, 2.1, 4.1, 4.2, 4.3, 4.7, 4.8
 */
export interface FilingPlan {
  // --- Intent detection ---
  /** Intent type: capture, query, status_update, or discuss */
  intent: FilingIntent;
  /** Intent confidence score (0.0 to 1.0) */
  intent_confidence: number;

  // --- Organic filing fields ---
  /** Full path where content should be stored (e.g., "25_Real_Estate/CNC_Mill_Build/research-notes.md") */
  file_path: string;
  /** Integration action to perform */
  action: IntegrationAction;
  /** For "move" action: destination path */
  destination_path?: string;
  /** For "update"/"delete" with section targeting */
  section_target?: string;
  /** How this content relates to existing material */
  integration_metadata: IntegrationMetadata;

  // --- Content fields ---
  /** Title for the content/file */
  title: string;
  /** Markdown content body */
  content: string;
  /** Classifier's reasoning for the filing decision */
  reasoning: string;

  // --- Existing fields preserved ---
  /** Task routing details */
  task_details?: { title: string; context: string; due_date?: string } | null;
  /** Query response for intent="query" */
  query_response?: string;
  /** Cited files for query responses */
  cited_files?: string[];
  /** Status update for intent="status_update" */
  status_update?: { project_reference: string; target_status: string } | null;
  /** Cross-item links */
  linked_items?: FilingLinkedItem[];

  // --- Discuss mode fields ---
  /** Conversational response (for intent="discuss") */
  discuss_response?: string;
  /** Session ID for conversation continuity */
  session_id?: string;
}

/**
 * Filing Plan validation result
 * Validates: Requirement 4.1
 */
export interface FilingPlanValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Path validation result
 * Validates: Requirements 1.3, 7.2
 */
export interface PathValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Valid filing intent values
 */
export const VALID_FILING_INTENTS: readonly FilingIntent[] = [
  'capture',
  'query',
  'status_update',
  'discuss',
];

/**
 * Valid integration action values
 */
export const VALID_INTEGRATION_ACTIONS: readonly IntegrationAction[] = [
  'create',
  'append',
  'update',
  'delete',
  'move',
];

/**
 * Valid content disposition values
 */
export const VALID_CONTENT_DISPOSITIONS: readonly ContentDisposition[] = [
  'new_topic',
  'continuation',
  'supersedes',
  'contradicts',
  'refines',
];
