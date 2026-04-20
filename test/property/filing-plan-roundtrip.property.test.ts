/**
 * Property-Based Tests: Filing Plan Round-Trip Serialization
 *
 * Feature: organic-knowledge-filing, Property 3: Filing Plan round-trip serialization
 *
 * **Validates: Requirements 4.5, 4.6, 10.3, 12.1, 12.2, 12.3**
 *
 * For any valid Filing Plan object (including all optional fields when present),
 * serializing to JSON via JSON.stringify and then parsing back SHALL produce a deeply
 * equal object. Furthermore, wrapping the JSON in a code block and passing to
 * parseFilingPlanFromLLM SHALL successfully extract the Filing Plan.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseFilingPlanFromLLM } from '../../src/components/filing-plan-validator';
import type {
  FilingPlan,
  IntegrationAction,
  ContentDisposition,
  FilingIntent,
} from '../../src/types/filing-plan';
import {
  VALID_INTEGRATION_ACTIONS,
  VALID_CONTENT_DISPOSITIONS,
  VALID_FILING_INTENTS,
} from '../../src/types/filing-plan';

// --- Arbitraries ---

const validIntent: fc.Arbitrary<FilingIntent> = fc.constantFrom(...VALID_FILING_INTENTS);
const validAction: fc.Arbitrary<IntegrationAction> = fc.constantFrom(...VALID_INTEGRATION_ACTIONS);
const validContentDisposition: fc.Arbitrary<ContentDisposition> = fc.constantFrom(
  ...VALID_CONTENT_DISPOSITIONS
);

const validIntegrationMetadata = fc.record({
  related_files: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 5 }),
  content_disposition: validContentDisposition,
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
});

const validLinkedItem = fc.record({
  sb_id: fc.string({ minLength: 5, maxLength: 15 }).map((s) => `sb-${s}`),
  title: fc.string({ minLength: 1, maxLength: 50 }),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
});

const validTaskDetails = fc.record({
  title: fc.string({ minLength: 1, maxLength: 50 }),
  context: fc.string({ minLength: 1, maxLength: 100 }),
  due_date: fc.option(fc.string({ minLength: 10, maxLength: 10 }), { nil: undefined }),
});

const validStatusUpdate = fc.record({
  project_reference: fc.string({ minLength: 1, maxLength: 50 }),
  target_status: fc.string({ minLength: 1, maxLength: 30 }),
});

/** Generate a complete valid FilingPlan with all optional fields */
const validFilingPlan: fc.Arbitrary<FilingPlan> = fc
  .record({
    intent: validIntent,
    intent_confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    file_path: fc.string({ minLength: 1, maxLength: 80 }),
    action: validAction,
    destination_path: fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: undefined }),
    section_target: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    integration_metadata: validIntegrationMetadata,
    title: fc.string({ minLength: 1, maxLength: 100 }),
    content: fc.string({ minLength: 1, maxLength: 500 }),
    reasoning: fc.string({ minLength: 1, maxLength: 200 }),
    task_details: fc.option(validTaskDetails, { nil: undefined }),
    query_response: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
    cited_files: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }), { nil: undefined }),
    status_update: fc.option(validStatusUpdate, { nil: undefined }),
    linked_items: fc.option(fc.array(validLinkedItem, { minLength: 0, maxLength: 3 }), { nil: undefined }),
    discuss_response: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
    session_id: fc.option(fc.string({ minLength: 5, maxLength: 15 }).map((s) => `ds-${s}`), { nil: undefined }),
  })
  .map((plan) => {
    // Remove undefined optional fields to match JSON round-trip behavior
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(plan)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result as unknown as FilingPlan;
  });

describe('Property 3: Filing Plan round-trip serialization', () => {
  it('JSON.stringify → JSON.parse produces deeply equal object', () => {
    fc.assert(
      fc.property(validFilingPlan, (plan) => {
        const serialized = JSON.stringify(plan);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(plan);
      }),
      { numRuns: 100 }
    );
  });

  it('code-block wrapping → parseFilingPlanFromLLM extracts correctly', () => {
    fc.assert(
      fc.property(validFilingPlan, (plan) => {
        const json = JSON.stringify(plan, null, 2);
        const wrapped = '```json\n' + json + '\n```';
        const extracted = parseFilingPlanFromLLM(wrapped);
        expect(extracted).not.toBeNull();
        expect(extracted).toEqual(plan);
      }),
      { numRuns: 100 }
    );
  });

  it('direct JSON string → parseFilingPlanFromLLM extracts correctly', () => {
    fc.assert(
      fc.property(validFilingPlan, (plan) => {
        const json = JSON.stringify(plan);
        const extracted = parseFilingPlanFromLLM(json);
        expect(extracted).not.toBeNull();
        expect(extracted).toEqual(plan);
      }),
      { numRuns: 100 }
    );
  });

  it('JSON embedded in surrounding text → parseFilingPlanFromLLM extracts correctly', () => {
    fc.assert(
      fc.property(
        validFilingPlan,
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('{') && !s.includes('}')),
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('{') && !s.includes('}')),
        (plan, prefix, suffix) => {
          const json = JSON.stringify(plan);
          const wrapped = `${prefix}\n${json}\n${suffix}`;
          const extracted = parseFilingPlanFromLLM(wrapped);
          expect(extracted).not.toBeNull();
          expect(extracted).toEqual(plan);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('round-trip preserves all optional fields when present', () => {
    fc.assert(
      fc.property(validFilingPlan, (plan) => {
        const json = JSON.stringify(plan, null, 2);
        const parsed = JSON.parse(json);
        const keys = Object.keys(plan);
        const parsedKeys = Object.keys(parsed);
        expect(parsedKeys.sort()).toEqual(keys.sort());
      }),
      { numRuns: 100 }
    );
  });
});
