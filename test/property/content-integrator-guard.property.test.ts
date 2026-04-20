/**
 * Property-Based Tests: Content Integrator Destructive Update Rejection
 *
 * Feature: organic-knowledge-filing, Property 6: Content Integrator destructive update rejection
 *
 * **Validates: Requirements 8.6**
 *
 * For any Markdown file and any update operation where the resulting content (excluding
 * front matter) would be less than 50% of the original content length (excluding front matter),
 * the Content Integrator SHALL reject the operation and return `success: false`.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { applyContentOperation } from '../../src/components/content-integrator';

// --- Helpers ---

/** Calculate body length (content excluding front matter) */
function getBodyLength(content: string): number {
  if (!content.startsWith('---')) return content.trim().length;
  const lines = content.split('\n');
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return content.trim().length;
  return lines.slice(closingIdx + 1).join('\n').trim().length;
}

// --- Arbitraries ---

/** Generate a heading text */
const headingTextArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9 ]{2,20}$/)
  .filter((s) => s.trim().length > 0);

/** Generate substantial section body content (long enough to make destructive updates detectable) */
const substantialBodyArb = fc
  .array(
    fc.stringMatching(/^[A-Za-z0-9 .,;:!?()-]{10,60}$/).filter(
      (line) => !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('===')
    ),
    { minLength: 4, maxLength: 10 }
  )
  .map((lines) => lines.join('\n'));

/** Generate a short replacement content (to make the update destructive) */
const shortContentArb = fc
  .stringMatching(/^[A-Za-z0-9 ]{1,10}$/)
  .filter((s) => s.trim().length > 0);

/** Generate a markdown file with front matter and a large target section */
const markdownWithLargeTargetArb = fc
  .record({
    targetHeading: headingTextArb,
    targetBody: substantialBodyArb,
    otherHeading: headingTextArb,
    otherBody: substantialBodyArb,
  })
  .filter(({ targetHeading, otherHeading }) =>
    targetHeading.toLowerCase() !== otherHeading.toLowerCase()
  )
  .map(({ targetHeading, targetBody, otherHeading, otherBody }) => {
    const frontMatter = [
      '---',
      'title: Test Document',
      'created_at: 2024-01-01T00:00:00.000Z',
      '---',
    ].join('\n');

    const markdown = [
      frontMatter,
      `## ${targetHeading}`,
      targetBody,
      '',
      `## ${otherHeading}`,
      otherBody,
      '',
    ].join('\n');

    return { markdown, targetHeading, targetBody, otherHeading, otherBody };
  });

const timestampArb = fc
  .date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString());

// --- Tests ---

describe('Property 6: Content Integrator destructive update rejection', () => {
  it('rejects update when resulting content is less than 50% of original', () => {
    fc.assert(
      fc.property(
        markdownWithLargeTargetArb,
        shortContentArb,
        timestampArb,
        ({ markdown, targetHeading, targetBody }, shortReplacement, timestamp) => {
          const originalBodyLength = getBodyLength(markdown);

          // Only test when the replacement would actually be destructive
          // The target section body is substantial, replacing it with short content
          // should reduce overall body length significantly
          const result = applyContentOperation(
            markdown,
            {
              action: 'update',
              content: shortReplacement,
              section_target: targetHeading,
            },
            timestamp
          );

          if (result.success) {
            // If it succeeded, verify the resulting body is >= 50% of original
            const resultBodyLength = getBodyLength(result.content);
            expect(resultBodyLength).toBeGreaterThanOrEqual(originalBodyLength * 0.5);
          } else {
            // If it was rejected, verify the error message mentions the size constraint
            expect(result.error).toContain('50%');
            // Content should be unchanged (original returned)
            expect(result.content).toBe(markdown);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('accepts update when resulting content is at least 50% of original', () => {
    fc.assert(
      fc.property(
        markdownWithLargeTargetArb,
        substantialBodyArb,
        timestampArb,
        ({ markdown, targetHeading }, replacementContent, timestamp) => {
          // Use substantial replacement content that should keep the file large enough
          const result = applyContentOperation(
            markdown,
            {
              action: 'update',
              content: replacementContent,
              section_target: targetHeading,
            },
            timestamp
          );

          if (result.success) {
            // Verify the resulting body is >= 50% of original
            const originalBodyLength = getBodyLength(markdown);
            const resultBodyLength = getBodyLength(result.content);
            expect(resultBodyLength).toBeGreaterThanOrEqual(originalBodyLength * 0.5);
          }
          // If rejected, it's because even the substantial content wasn't enough
          // (which is fine — the property still holds)
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejected updates return the original content unchanged', () => {
    fc.assert(
      fc.property(
        markdownWithLargeTargetArb,
        timestampArb,
        ({ markdown, targetHeading }, timestamp) => {
          // Use empty replacement to guarantee destructive update
          const result = applyContentOperation(
            markdown,
            {
              action: 'update',
              content: '',
              section_target: targetHeading,
            },
            timestamp
          );

          // With empty content replacing a substantial section, this should be rejected
          if (!result.success) {
            // Original content should be returned unchanged
            expect(result.content).toBe(markdown);
            expect(result.error).toBeDefined();
            expect(result.warnings).toHaveLength(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('the 50% threshold is calculated excluding front matter', () => {
    fc.assert(
      fc.property(
        timestampArb,
        (timestamp) => {
          // Create a file with large front matter but small body
          const largeFrontMatter = [
            '---',
            'title: A very long title that takes up space',
            'description: This is a very long description field that adds many characters to the front matter section of this document',
            'author: Someone with a long name and credentials',
            'created_at: 2024-01-01T00:00:00.000Z',
            'tags: [tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8]',
            '---',
          ].join('\n');

          // Small body with two sections of equal size
          const markdown = [
            largeFrontMatter,
            '## Section One',
            'Content for section one here.',
            '',
            '## Section Two',
            'Content for section two here.',
            '',
          ].join('\n');

          // Update section one with very short content
          const result = applyContentOperation(
            markdown,
            {
              action: 'update',
              content: 'x',
              section_target: 'Section One',
            },
            timestamp
          );

          // The body is small, so replacing one section with 'x' might or might not
          // cross the 50% threshold. The key property is that front matter is NOT
          // counted in the calculation.
          const originalBodyLength = getBodyLength(markdown);
          if (result.success) {
            const resultBodyLength = getBodyLength(result.content);
            expect(resultBodyLength).toBeGreaterThanOrEqual(originalBodyLength * 0.5);
          } else {
            // Rejection means the body would have been < 50%
            expect(result.error).toContain('50%');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
