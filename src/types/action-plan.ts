/**
 * Action Plan Types and Interfaces
 * 
 * Validates: Requirement 42 (Action Plan Output Contract)
 * Validates: Requirement 53 (Intent Classification - Phase 2)
 */

import type { Classification } from './classification';

/**
 * Intent type for Phase 2 semantic query support
 * Validates: Requirement 53.1
 */
export type Intent = 'capture' | 'query';

/**
 * Linked item reference for cross-item linking
 * Validates: Requirements 2.1, 2.2, 2.4
 */
export interface LinkedItem {
  /** SB_ID of the linked item (e.g., "sb-a7f3c2d") */
  sb_id: string;
  /** Human-readable title of the linked item */
  title: string;
  /** Confidence score for the link match (0.0 to 1.0) */
  confidence: number;
}

/**
 * File operation types
 */
export type FileOperationType = 'create' | 'append' | 'update';

/**
 * File operation in an Action Plan
 */
export interface FileOperation {
  path: string;
  operation: FileOperationType;
  content: string;
}

/**
 * OmniFocus email in an Action Plan
 */
export interface OmniFocusEmail {
  subject: string;
  body: string;
}

/**
 * Action Plan output from AgentCore
 * 
 * This is the structured output that AgentCore returns.
 * Lambda validates this against the schema before executing side effects.
 * 
 * Validates: Requirement 42 (Action Plan Output Contract)
 * Validates: Requirement 53 (Intent Classification - Phase 2)
 * Validates: Requirement 1.1 (SB_ID Canonical Identifier)
 */
export interface ActionPlan {
  /** Intent type: capture (store new info) or query (retrieve existing info) */
  intent: Intent;
  
  /** Intent confidence score (0.0 to 1.0) */
  intent_confidence: number;
  
  /** Classification type (required for capture intent, null for query) */
  classification: Classification | null;
  
  /** Classification confidence score (0.0 to 1.0, for capture intent) */
  confidence: number;
  
  /** Whether clarification is needed */
  needs_clarification: boolean;
  
  /** Clarification prompt (if needs_clarification is true) */
  clarification_prompt?: string;
  
  /** File operations to perform (empty for query intent) */
  file_operations: FileOperation[];
  
  /** Commit message for CodeCommit (for capture intent) */
  commit_message: string;
  
  /** OmniFocus email (for task classification) */
  omnifocus_email?: OmniFocusEmail;
  
  /** Slack reply text */
  slack_reply_text: string;
  
  /** Query response (for query intent) - Phase 2 */
  query_response?: string;
  
  /** Cited files for query response (for query intent) - Phase 2 */
  cited_files?: string[];
  
  /** Canonical identifier for durable items (idea, decision, project) */
  sb_id?: string;
  
  /** Linked items for cross-item linking (ideas, decisions, projects, tasks) */
  linked_items?: LinkedItem[];
}

/**
 * Action Plan validation result
 */
export interface ActionPlanValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Valid intent types
 */
const VALID_INTENTS: readonly Intent[] = ['capture', 'query'];

/**
 * Valid file operation types
 */
const VALID_FILE_OPERATIONS: readonly FileOperationType[] = ['create', 'append', 'update'];

/**
 * Valid classification values
 */
const VALID_CLASSIFICATIONS: readonly Classification[] = ['inbox', 'idea', 'decision', 'project', 'task'];

/**
 * Valid path prefixes for each classification
 * @deprecated Legacy classification-to-path mapping. Use organic filing paths instead.
 */
const VALID_PATH_PREFIXES: Record<Classification, string> = {
  inbox: '',
  idea: '',
  decision: '',
  project: '',
  task: '',
};

/**
 * Validate an Action Plan against the schema
 * 
 * Validates: Requirement 43 (Action Plan Validation)
 * Validates: Requirement 53 (Intent Classification - Phase 2)
 */
export function validateActionPlan(plan: unknown): ActionPlanValidationResult {
  const errors: string[] = [];
  
  if (typeof plan !== 'object' || plan === null) {
    return { valid: false, errors: ['Action Plan must be an object'] };
  }
  
  const p = plan as Record<string, unknown>;
  
  // Intent fields (Phase 2) - required
  if (typeof p.intent !== 'string') {
    errors.push('intent must be a string');
  } else if (!VALID_INTENTS.includes(p.intent as Intent)) {
    errors.push(`intent must be one of: ${VALID_INTENTS.join(', ')}`);
  }
  
  if (typeof p.intent_confidence !== 'number') {
    errors.push('intent_confidence must be a number');
  } else if (p.intent_confidence < 0 || p.intent_confidence > 1) {
    errors.push('intent_confidence must be between 0.0 and 1.0');
  }
  
  const isQueryIntent = p.intent === 'query';
  
  // Classification validation (required for capture, null for query)
  if (isQueryIntent) {
    // For query intent, classification should be null or not present
    if (p.classification !== null && p.classification !== undefined) {
      errors.push('classification must be null for query intent');
    }
  } else {
    // For capture intent, classification is required
    if (typeof p.classification !== 'string') {
      errors.push('classification must be a string for capture intent');
    } else if (!VALID_CLASSIFICATIONS.includes(p.classification as Classification)) {
      errors.push(`classification must be one of: ${VALID_CLASSIFICATIONS.join(', ')}`);
    }
  }
  
  if (typeof p.confidence !== 'number') {
    errors.push('confidence must be a number');
  } else if (p.confidence < 0 || p.confidence > 1) {
    errors.push('confidence must be between 0.0 and 1.0');
  }
  
  if (typeof p.needs_clarification !== 'boolean') {
    errors.push('needs_clarification must be a boolean');
  }
  
  if (p.needs_clarification === true && typeof p.clarification_prompt !== 'string') {
    errors.push('clarification_prompt is required when needs_clarification is true');
  }
  
  // File operations validation
  if (!Array.isArray(p.file_operations)) {
    errors.push('file_operations must be an array');
  } else {
    // For query intent, file_operations must be empty
    if (isQueryIntent && p.file_operations.length > 0) {
      errors.push('file_operations must be empty for query intent');
    }
    
    p.file_operations.forEach((op, index) => {
      if (typeof op !== 'object' || op === null) {
        errors.push(`file_operations[${index}] must be an object`);
        return;
      }
      
      const fileOp = op as Record<string, unknown>;
      
      if (typeof fileOp.path !== 'string') {
        errors.push(`file_operations[${index}].path must be a string`);
      } else if (!isQueryIntent) {
        // Validate path matches classification taxonomy (only for capture intent)
        const classification = p.classification as Classification;
        const expectedPrefix = VALID_PATH_PREFIXES[classification];
        if (expectedPrefix && !fileOp.path.startsWith(expectedPrefix)) {
          errors.push(
            `file_operations[${index}].path must start with '${expectedPrefix}' for ${classification} classification`
          );
        }
      }
      
      if (typeof fileOp.operation !== 'string') {
        errors.push(`file_operations[${index}].operation must be a string`);
      } else if (!VALID_FILE_OPERATIONS.includes(fileOp.operation as FileOperationType)) {
        errors.push(
          `file_operations[${index}].operation must be one of: ${VALID_FILE_OPERATIONS.join(', ')}`
        );
      }
      
      if (typeof fileOp.content !== 'string') {
        errors.push(`file_operations[${index}].content must be a string`);
      }
    });
  }
  
  if (typeof p.commit_message !== 'string') {
    errors.push('commit_message must be a string');
  }
  
  // Optional omnifocus_email validation
  if (p.omnifocus_email !== undefined) {
    if (typeof p.omnifocus_email !== 'object' || p.omnifocus_email === null) {
      errors.push('omnifocus_email must be an object');
    } else {
      const email = p.omnifocus_email as Record<string, unknown>;
      if (typeof email.subject !== 'string') {
        errors.push('omnifocus_email.subject must be a string');
      }
      if (typeof email.body !== 'string') {
        errors.push('omnifocus_email.body must be a string');
      }
    }
  }
  
  if (typeof p.slack_reply_text !== 'string') {
    errors.push('slack_reply_text must be a string');
  }
  
  // Query-specific validation (Phase 2)
  if (isQueryIntent) {
    if (typeof p.query_response !== 'string') {
      errors.push('query_response is required for query intent');
    }
    if (!Array.isArray(p.cited_files)) {
      errors.push('cited_files must be an array for query intent');
    } else {
      p.cited_files.forEach((file, index) => {
        if (typeof file !== 'string') {
          errors.push(`cited_files[${index}] must be a string`);
        }
      });
    }
  }
  
  // Optional linked_items validation (cross-item linking)
  // Validates: Requirements 2.1, 2.2, 2.4
  if (p.linked_items !== undefined) {
    if (!Array.isArray(p.linked_items)) {
      errors.push('linked_items must be an array');
    } else {
      const SB_ID_PATTERN = /^sb-[a-f0-9]{7}$/;
      p.linked_items.forEach((item, index) => {
        if (typeof item !== 'object' || item === null) {
          errors.push(`linked_items[${index}] must be an object`);
          return;
        }
        
        const linkedItem = item as Record<string, unknown>;
        
        // Validate sb_id format
        if (typeof linkedItem.sb_id !== 'string') {
          errors.push(`linked_items[${index}].sb_id must be a string`);
        } else if (!SB_ID_PATTERN.test(linkedItem.sb_id)) {
          errors.push(`linked_items[${index}].sb_id must match format sb-[a-f0-9]{7}`);
        }
        
        // Validate title is non-empty string
        if (typeof linkedItem.title !== 'string') {
          errors.push(`linked_items[${index}].title must be a string`);
        } else if (linkedItem.title.length === 0) {
          errors.push(`linked_items[${index}].title must be non-empty`);
        }
        
        // Validate confidence is number between 0 and 1
        if (typeof linkedItem.confidence !== 'number') {
          errors.push(`linked_items[${index}].confidence must be a number`);
        } else if (linkedItem.confidence < 0 || linkedItem.confidence > 1) {
          errors.push(`linked_items[${index}].confidence must be between 0.0 and 1.0`);
        }
      });
    }
  }
  
  // Check for unexpected fields
  const expectedFields = [
    'intent',
    'intent_confidence',
    'classification',
    'confidence',
    'needs_clarification',
    'clarification_prompt',
    'file_operations',
    'commit_message',
    'omnifocus_email',
    'slack_reply_text',
    'query_response',
    'cited_files',
    'sb_id',
    'linked_items',
  ];
  
  Object.keys(p).forEach((key) => {
    if (!expectedFields.includes(key)) {
      errors.push(`Unexpected field: ${key}`);
    }
  });
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parse Action Plan from LLM output
 * Extracts JSON from potentially wrapped response
 */
export function parseActionPlanFromLLM(llmOutput: string): ActionPlan | null {
  try {
    // Try direct parse first
    return JSON.parse(llmOutput) as ActionPlan;
  } catch {
    // Try to extract JSON from markdown code block
    const jsonMatch = llmOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim()) as ActionPlan;
      } catch {
        return null;
      }
    }
    
    // Try to find JSON object in the output
    const objectMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as ActionPlan;
      } catch {
        return null;
      }
    }
    
    return null;
  }
}
