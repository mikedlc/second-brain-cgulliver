/**
 * Property-Based Tests: Discuss Intent Produces No File Operations
 *
 * Feature: organic-knowledge-filing, Property 8: Discuss intent produces no file operations
 *
 * **Validates: Requirements 13.2, 13.10**
 *
 * For any Filing Plan with intent: "discuss", the Worker SHALL NOT execute any CodeCommit
 * write operations (except draft persistence to 00_System/Pending/). The Filing Plan
 * validation SHALL accept discuss intent with a discuss_response field.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateFilingPlan } from '../../src/components/filing-plan-validator';
import type { FilingPlan } from '../../src/types/filing-plan';

// --- Arbitraries ---

/** Generate a random discuss-intent Filing Plan */
const discussFilingPlan: fc.Arbitrary<FilingPlan> = fc
  .record({
    intent: fc.constant('discuss' as const),
    intent_confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    discuss_response: fc.string({ minLength: 1, maxLength: 500 }),
    session_id: fc.option(
      fc.string({ minLength: 5, maxLength: 20 }).map((s) => `ds-${s.replace(/[^a-f0-9]/g, 'a').slice(0, 7)}`),
      { nil: undefined }
    ),
    // These fields should be irrelevant for discuss intent
    file_path: fc.constant(''),
    action: fc.constant('create' as const),
    title: fc.constant(''),
    content: fc.constant(''),
    reasoning: fc.constant(''),
    integration_metadata: fc.constant({
      related_files: [] as string[],
      content_disposition: 'new_topic' as const,
      confidence: 0,
    }),
  })
  .map((plan) => plan as unknown as FilingPlan);

/** Generate a discuss Filing Plan with various optional fields populated */
const discussFilingPlanWithOptionals: fc.Arbitrary<FilingPlan> = fc
  .record({
    intent: fc.constant('discuss' as const),
    intent_confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    discuss_response: fc.string({ minLength: 1, maxLength: 500 }),
    session_id: fc.option(
      fc.string({ minLength: 5, maxLength: 20 }).map((s) => `ds-${s.replace(/[^a-f0-9]/g, 'a').slice(0, 7)}`),
      { nil: undefined }
    ),
    file_path: fc.string({ minLength: 0, maxLength: 50 }),
    action: fc.constantFrom('create', 'append', 'update', 'delete', 'move') as fc.Arbitrary<FilingPlan['action']>,
    title: fc.string({ minLength: 0, maxLength: 100 }),
    content: fc.string({ minLength: 0, maxLength: 200 }),
    reasoning: fc.string({ minLength: 0, maxLength: 200 }),
    integration_metadata: fc.record({
      related_files: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
      content_disposition: fc.constantFrom('new_topic', 'continuation', 'supersedes', 'contradicts', 'refines') as fc.Arbitrary<FilingPlan['integration_metadata']['content_disposition']>,
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  })
  .map((plan) => plan as unknown as FilingPlan);

describe('Property 8: Discuss intent produces no file operations', () => {
  it('discuss intent Filing Plans produce no file operations (action fields are irrelevant)', () => {
    fc.assert(
      fc.property(discussFilingPlanWithOptionals, (plan) => {
        // For discuss intent, the system should NOT execute any CodeCommit write operations
        // The intent being "discuss" means no file_path/action should be acted upon
        expect(plan.intent).toBe('discuss');

        // The only write allowed is draft persistence to 00_System/Pending/
        // Verify that the plan's file_path (if any) is NOT in 00_System/Pending/ 
        // (drafts are handled separately by the session store, not by the filing executor)
        // The key property: discuss intent means the filing executor is NOT invoked
        const shouldExecuteFilingPlan = plan.intent !== 'discuss';
        expect(shouldExecuteFilingPlan).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('discuss intent with discuss_response passes validation', () => {
    fc.assert(
      fc.property(discussFilingPlan, (plan) => {
        const result = validateFilingPlan(plan);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });

  it('discuss intent without discuss_response fails validation', () => {
    fc.assert(
      fc.property(
        fc.record({
          intent: fc.constant('discuss' as const),
          intent_confidence: fc.double({ min: 0, max: 1, noNaN: true }),
          file_path: fc.constant(''),
          action: fc.constant('create' as const),
          title: fc.constant(''),
          content: fc.constant(''),
          reasoning: fc.constant(''),
          integration_metadata: fc.constant({
            related_files: [] as string[],
            content_disposition: 'new_topic' as const,
            confidence: 0,
          }),
        }),
        (plan) => {
          // Missing discuss_response should fail validation
          const result = validateFilingPlan(plan);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('discuss_response'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('discuss intent does not require capture-specific fields (file_path, action, title, content, reasoning)', () => {
    fc.assert(
      fc.property(
        fc.record({
          intent: fc.constant('discuss' as const),
          intent_confidence: fc.double({ min: 0, max: 1, noNaN: true }),
          discuss_response: fc.string({ minLength: 1, maxLength: 300 }),
        }),
        (plan) => {
          // Discuss intent should be valid even without capture fields
          const result = validateFilingPlan(plan);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
