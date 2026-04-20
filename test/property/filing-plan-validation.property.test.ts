/**
 * Property-Based Tests: Filing Plan Schema Validation
 *
 * Feature: organic-knowledge-filing, Property 1: Filing Plan schema validation
 *
 * **Validates: Requirements 1.1, 2.1, 2.5, 4.1, 4.2, 4.3, 4.4, 4.7**
 *
 * For any Filing Plan object with intent: "capture", the validation function SHALL require
 * the fields file_path, action, title, content, reasoning, and integration_metadata to be
 * present and non-null. Additionally: when action is "update", section_target SHALL be required;
 * when action is "move", destination_path SHALL be required; integration_metadata SHALL contain
 * related_files (array), content_disposition (valid enum value), and confidence (number 0.0-1.0);
 * and action SHALL be one of the five valid values (create, append, update, delete, move).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateFilingPlan } from '../../src/components/filing-plan-validator';
import type { FilingPlan, IntegrationAction, ContentDisposition } from '../../src/types/filing-plan';
import {
  VALID_INTEGRATION_ACTIONS,
  VALID_CONTENT_DISPOSITIONS,
} from '../../src/types/filing-plan';

// --- Arbitraries ---

const validContentDisposition: fc.Arbitrary<ContentDisposition> = fc.constantFrom(
  ...VALID_CONTENT_DISPOSITIONS
);

const validIntegrationMetadata = fc.record({
  related_files: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 5 }),
  content_disposition: validContentDisposition,
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
});

const validAction: fc.Arbitrary<IntegrationAction> = fc.constantFrom(...VALID_INTEGRATION_ACTIONS);

const validCaptureFilingPlan: fc.Arbitrary<FilingPlan> = fc
  .record({
    intent: fc.constant('capture' as const),
    intent_confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    file_path: fc.string({ minLength: 1, maxLength: 100 }),
    action: validAction,
    title: fc.string({ minLength: 1, maxLength: 100 }),
    content: fc.string({ minLength: 1, maxLength: 500 }),
    reasoning: fc.string({ minLength: 1, maxLength: 200 }),
    integration_metadata: validIntegrationMetadata,
  })
  .map((plan) => {
    const result: FilingPlan = { ...plan } as FilingPlan;
    if (plan.action === 'update') {
      result.section_target = '## Some Section';
    }
    if (plan.action === 'move') {
      result.destination_path = '10_Work/destination.md';
    }
    return result;
  });

describe('Property 1: Filing Plan schema validation', () => {
  it('should accept valid capture-intent Filing Plans', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const result = validateFilingPlan(plan);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });

  it('should require file_path for capture intent', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, file_path: '' };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('file_path'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require action for capture intent', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, action: undefined };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('action'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require title for capture intent', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, title: '' };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('title'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require content for capture intent', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, content: '' };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('content'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require reasoning for capture intent', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, reasoning: '' };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('reasoning'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require integration_metadata for capture intent', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, integration_metadata: undefined };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('integration_metadata'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require section_target when action is "update"', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, action: 'update' as const, section_target: undefined };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('section_target'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should require destination_path when action is "move"', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = { ...plan, action: 'move' as const, destination_path: undefined };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('destination_path'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should reject invalid action values', () => {
    fc.assert(
      fc.property(
        validCaptureFilingPlan,
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => !VALID_INTEGRATION_ACTIONS.includes(s as IntegrationAction)
        ),
        (plan, invalidAction) => {
          const invalid = { ...plan, action: invalidAction };
          const result = validateFilingPlan(invalid);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('action'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should validate integration_metadata.related_files is an array', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, (plan) => {
        const invalid = {
          ...plan,
          integration_metadata: { ...plan.integration_metadata, related_files: 'not-an-array' },
        };
        const result = validateFilingPlan(invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('related_files'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should validate integration_metadata.content_disposition is a valid enum', () => {
    fc.assert(
      fc.property(
        validCaptureFilingPlan,
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => !VALID_CONTENT_DISPOSITIONS.includes(s as ContentDisposition)
        ),
        (plan, invalidDisposition) => {
          const invalid = {
            ...plan,
            integration_metadata: {
              ...plan.integration_metadata,
              content_disposition: invalidDisposition,
            },
          };
          const result = validateFilingPlan(invalid);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('content_disposition'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should validate integration_metadata.confidence is between 0.0 and 1.0', () => {
    fc.assert(
      fc.property(
        validCaptureFilingPlan,
        fc.double({ min: 1.01, max: 100, noNaN: true }),
        (plan, invalidConfidence) => {
          const invalid = {
            ...plan,
            integration_metadata: {
              ...plan.integration_metadata,
              confidence: invalidConfidence,
            },
          };
          const result = validateFilingPlan(invalid);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should accept all five valid action values', () => {
    fc.assert(
      fc.property(validCaptureFilingPlan, validAction, (plan, action) => {
        const valid: Record<string, unknown> = { ...plan, action };
        if (action === 'update') {
          valid.section_target = '## Target Section';
        }
        if (action === 'move') {
          valid.destination_path = '20_Personal/moved.md';
        }
        const result = validateFilingPlan(valid);
        expect(result.errors.some((e) => e.includes('action must be one of'))).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
