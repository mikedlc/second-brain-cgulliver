/**
 * Filing Plan Validator
 *
 * Validates Filing Plan objects against the schema contract between Classifier and Worker.
 * Handles intent-specific validation rules for capture, discuss, and query intents.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
 */

import type {
  FilingPlan,
  FilingPlanValidationResult,
  FilingIntent,
  IntegrationAction,
  ContentDisposition,
} from '../types/filing-plan';

import {
  VALID_FILING_INTENTS,
  VALID_INTEGRATION_ACTIONS,
  VALID_CONTENT_DISPOSITIONS,
} from '../types/filing-plan';

/**
 * Validate a Filing Plan object against the schema.
 *
 * Validation rules by intent:
 * - capture: requires file_path, action, title, content, reasoning, integration_metadata
 *   - action "update" requires section_target
 *   - action "move" requires destination_path
 *   - integration_metadata requires related_files (array), content_disposition (enum), confidence (0.0-1.0)
 * - discuss: requires discuss_response
 * - query: minimal validation (just intent + intent_confidence)
 */
export function validateFilingPlan(plan: unknown): FilingPlanValidationResult {
  const errors: string[] = [];

  if (typeof plan !== 'object' || plan === null) {
    return { valid: false, errors: ['Filing Plan must be an object'] };
  }

  const p = plan as Record<string, unknown>;

  // --- Intent validation (required for all intents) ---
  if (typeof p.intent !== 'string') {
    errors.push('intent must be a string');
  } else if (!VALID_FILING_INTENTS.includes(p.intent as FilingIntent)) {
    errors.push(`intent must be one of: ${VALID_FILING_INTENTS.join(', ')}`);
  }

  if (typeof p.intent_confidence !== 'number') {
    errors.push('intent_confidence must be a number');
  } else if (p.intent_confidence < 0 || p.intent_confidence > 1) {
    errors.push('intent_confidence must be between 0.0 and 1.0');
  }

  // --- Intent-specific validation ---
  const intent = p.intent as string;

  if (intent === 'capture') {
    validateCaptureIntent(p, errors);
  } else if (intent === 'discuss') {
    validateDiscussIntent(p, errors);
  }
  // query and status_update: minimal validation (just intent + intent_confidence above)

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate capture-intent specific fields.
 */
function validateCaptureIntent(p: Record<string, unknown>, errors: string[]): void {
  // Required fields for capture intent
  if (typeof p.file_path !== 'string' || p.file_path.length === 0) {
    errors.push('file_path is required for capture intent and must be a non-empty string');
  }

  if (typeof p.action !== 'string') {
    errors.push('action is required for capture intent and must be a string');
  } else if (!VALID_INTEGRATION_ACTIONS.includes(p.action as IntegrationAction)) {
    errors.push(`action must be one of: ${VALID_INTEGRATION_ACTIONS.join(', ')}`);
  } else {
    // Action-specific field requirements
    if (p.action === 'update') {
      if (typeof p.section_target !== 'string' || p.section_target.length === 0) {
        errors.push('section_target is required when action is "update"');
      }
    }

    if (p.action === 'move') {
      if (typeof p.destination_path !== 'string' || p.destination_path.length === 0) {
        errors.push('destination_path is required when action is "move"');
      }
    }
  }

  if (typeof p.title !== 'string' || p.title.length === 0) {
    errors.push('title is required for capture intent and must be a non-empty string');
  }

  if (typeof p.content !== 'string' || p.content.length === 0) {
    errors.push('content is required for capture intent and must be a non-empty string');
  }

  if (typeof p.reasoning !== 'string' || p.reasoning.length === 0) {
    errors.push('reasoning is required for capture intent and must be a non-empty string');
  }

  // integration_metadata validation
  validateIntegrationMetadata(p, errors);
}

/**
 * Validate integration_metadata sub-fields.
 */
function validateIntegrationMetadata(p: Record<string, unknown>, errors: string[]): void {
  if (typeof p.integration_metadata !== 'object' || p.integration_metadata === null) {
    errors.push('integration_metadata is required for capture intent and must be an object');
    return;
  }

  const meta = p.integration_metadata as Record<string, unknown>;

  // related_files must be an array
  if (!Array.isArray(meta.related_files)) {
    errors.push('integration_metadata.related_files must be an array');
  } else {
    meta.related_files.forEach((file, index) => {
      if (typeof file !== 'string') {
        errors.push(`integration_metadata.related_files[${index}] must be a string`);
      }
    });
  }

  // content_disposition must be a valid enum value
  if (typeof meta.content_disposition !== 'string') {
    errors.push('integration_metadata.content_disposition must be a string');
  } else if (
    !VALID_CONTENT_DISPOSITIONS.includes(meta.content_disposition as ContentDisposition)
  ) {
    errors.push(
      `integration_metadata.content_disposition must be one of: ${VALID_CONTENT_DISPOSITIONS.join(', ')}`
    );
  }

  // confidence must be a number between 0.0 and 1.0
  if (typeof meta.confidence !== 'number') {
    errors.push('integration_metadata.confidence must be a number');
  } else if (meta.confidence < 0 || meta.confidence > 1) {
    errors.push('integration_metadata.confidence must be between 0.0 and 1.0');
  }
}

/**
 * Validate discuss-intent specific fields.
 */
function validateDiscussIntent(p: Record<string, unknown>, errors: string[]): void {
  if (typeof p.discuss_response !== 'string' || p.discuss_response.length === 0) {
    errors.push('discuss_response is required for discuss intent and must be a non-empty string');
  }
}


/**
 * Parse a Filing Plan from raw LLM output.
 *
 * Extracts JSON from the response using three strategies:
 * 1. Look for ```json ... ``` code blocks and parse the content
 * 2. Try to parse the entire response as JSON directly
 * 3. Try to find any JSON object {...} in the response text
 *
 * Returns the parsed FilingPlan or null if extraction fails.
 *
 * Validates: Requirements 4.5, 4.6
 */
export function parseFilingPlanFromLLM(responseText: string): FilingPlan | null {
  // Strategy 1: Look for ```json ... ``` code blocks
  const jsonBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim()) as FilingPlan;
    } catch {
      // Continue to other strategies
    }
  }

  // Strategy 2: Try to parse the entire response as JSON directly
  try {
    return JSON.parse(responseText.trim()) as FilingPlan;
  } catch {
    // Continue to other strategies
  }

  // Strategy 3: Try to find any JSON object {...} in the response text
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as FilingPlan;
    } catch {
      // Failed to parse
    }
  }

  return null;
}
