/**
 * Property-Based Tests: Content Integrator Operation Isolation
 *
 * Feature: organic-knowledge-filing, Property 4: Content Integrator operation isolation
 *
 * **Validates: Requirements 2.6, 2.9, 8.1, 8.3, 8.7**
 *
 * For any Markdown file with multiple sections and any append, update, or section-delete
 * operation targeting a specific section, all sections NOT targeted by the operation SHALL
 * remain byte-for-byte identical in the output. For append operations, all original content
 * SHALL be preserved in the output (the output is a superset of the input).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  parseMarkdownSections,
  applyContentOperation,
} from '../../src/components/content-integrator';

// --- Arbitraries ---

/**
 * Generate a simple heading text — no trailing/leading spaces, no # prefix,
 * and must be distinct enough to avoid case-insensitive collisions.
 */
const headingTextArb = fc
  .stringMatching(/^[A-Z][a-z]{3,15}$/)
  .filter((s) => s.trim() === s && s.length >= 4);

/** Generate section body content (no lines starting with # to avoid being parsed as headings) */
const sectionBodyArb = fc
  .array(
    fc.stringMatching(/^[A-Za-z0-9 .,;:!?()-]{5,60}$/).filter(
      (line) =>
        !line.startsWith('#') &&
        !line.startsWith('---') &&
        !line.startsWith('===') &&
        line.trim().length > 0
    ),
    { minLength: 1, maxLength: 5 }
  )
  .map((lines) => lines.join('\n'));

/** Generate a markdown section (ATX heading + body) */
const sectionArb = fc.record({
  heading: headingTextArb,
  level: fc.integer({ min: 2, max: 4 }),
  body: sectionBodyArb,
});

/** Generate a markdown file with multiple sections (case-insensitively unique headings) */
const markdownWithSectionsArb = fc
  .array(sectionArb, { minLength: 3, maxLength: 6 })
  .map((sections) => {
    // Ensure case-insensitively unique headings
    const usedHeadings = new Set<string>();
    const uniqueSections = sections.filter((s) => {
      const lower = s.heading.toLowerCase();
      if (usedHeadings.has(lower)) return false;
      usedHeadings.add(lower);
      return true;
    });
    return uniqueSections;
  })
  .filter((sections) => sections.length >= 2);

/** Build a markdown string from sections (matching how the serializer works) */
function buildMarkdown(
  sections: Array<{ heading: string; level: number; body: string }>
): string {
  const parts: string[] = [];
  for (const section of sections) {
    const hashes = '#'.repeat(section.level);
    parts.push(`${hashes} ${section.heading}`);
    parts.push(section.body);
  }
  return parts.join('\n');
}

/** Generate new content to append/update */
const newContentArb = fc
  .array(
    fc.stringMatching(/^[A-Za-z0-9 .,;:!?()-]{5,40}$/).filter((s) => s.trim().length > 0),
    { minLength: 1, maxLength: 3 }
  )
  .map((lines) => lines.join('\n'));

const timestampArb = fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map(
  (d) => d.toISOString()
);

// --- Tests ---

describe('Property 4: Content Integrator operation isolation', () => {
  it('append to a specific section preserves all other sections byte-for-byte', () => {
    fc.assert(
      fc.property(
        markdownWithSectionsArb,
        newContentArb,
        timestampArb,
        fc.integer({ min: 0, max: 100 }),
        (sections, newContent, timestamp, targetSeed) => {
          const markdown = buildMarkdown(sections);

          // Parse the original to get the baseline section contents
          const originalParsed = parseMarkdownSections(markdown);

          // Pick a target section deterministically from the seed
          const targetIdx = targetSeed % sections.length;
          const targetHeading = sections[targetIdx].heading;

          const result = applyContentOperation(
            markdown,
            {
              action: 'append',
              content: newContent,
              section_target: targetHeading,
            },
            timestamp
          );

          expect(result.success).toBe(true);

          // Parse the output and verify non-targeted sections are unchanged
          const outputParsed = parseMarkdownSections(result.content);

          for (let i = 0; i < originalParsed.sections.length; i++) {
            const origSection = originalParsed.sections[i];
            if (origSection.heading.toLowerCase() === targetHeading.toLowerCase()) continue;

            const outputSection = outputParsed.sections.find(
              (s) => s.heading.toLowerCase() === origSection.heading.toLowerCase()
            );

            expect(outputSection).toBeDefined();
            expect(outputSection!.heading).toBe(origSection.heading);
            expect(outputSection!.content).toBe(origSection.content);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('update to a specific section preserves all other sections byte-for-byte', () => {
    fc.assert(
      fc.property(
        markdownWithSectionsArb,
        newContentArb,
        timestampArb,
        fc.integer({ min: 0, max: 100 }),
        (sections, newContent, timestamp, targetSeed) => {
          const markdown = buildMarkdown(sections);

          // Parse the original to get the baseline section contents
          const originalParsed = parseMarkdownSections(markdown);

          // Pick a target section deterministically
          const targetIdx = targetSeed % sections.length;
          const targetHeading = sections[targetIdx].heading;

          const result = applyContentOperation(
            markdown,
            {
              action: 'update',
              content: newContent,
              section_target: targetHeading,
            },
            timestamp
          );

          // The update may be rejected if it's too destructive (>50% removal)
          // We only check isolation when the operation succeeds
          if (!result.success) return;

          const outputParsed = parseMarkdownSections(result.content);

          for (let i = 0; i < originalParsed.sections.length; i++) {
            const origSection = originalParsed.sections[i];
            if (origSection.heading.toLowerCase() === targetHeading.toLowerCase()) continue;

            const outputSection = outputParsed.sections.find(
              (s) => s.heading.toLowerCase() === origSection.heading.toLowerCase()
            );

            expect(outputSection).toBeDefined();
            expect(outputSection!.heading).toBe(origSection.heading);
            expect(outputSection!.content).toBe(origSection.content);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('delete of a specific section preserves all other sections byte-for-byte', () => {
    fc.assert(
      fc.property(
        markdownWithSectionsArb,
        timestampArb,
        fc.integer({ min: 0, max: 100 }),
        (sections, timestamp, targetSeed) => {
          const markdown = buildMarkdown(sections);

          // Parse the original to get the baseline section contents
          const originalParsed = parseMarkdownSections(markdown);

          // Pick a target section deterministically
          const targetIdx = targetSeed % sections.length;
          const targetHeading = sections[targetIdx].heading;

          const result = applyContentOperation(
            markdown,
            {
              action: 'delete',
              section_target: targetHeading,
            },
            timestamp
          );

          expect(result.success).toBe(true);

          const outputParsed = parseMarkdownSections(result.content);

          // Verify the targeted section is removed
          const deletedSection = outputParsed.sections.find(
            (s) => s.heading.toLowerCase() === targetHeading.toLowerCase()
          );
          expect(deletedSection).toBeUndefined();

          // Verify all other sections are preserved
          for (let i = 0; i < originalParsed.sections.length; i++) {
            const origSection = originalParsed.sections[i];
            if (origSection.heading.toLowerCase() === targetHeading.toLowerCase()) continue;

            const outputSection = outputParsed.sections.find(
              (s) => s.heading.toLowerCase() === origSection.heading.toLowerCase()
            );

            expect(outputSection).toBeDefined();
            expect(outputSection!.heading).toBe(origSection.heading);
            expect(outputSection!.content).toBe(origSection.content);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('append preserves all original content (output is superset of input)', () => {
    fc.assert(
      fc.property(
        markdownWithSectionsArb,
        newContentArb,
        timestampArb,
        fc.integer({ min: 0, max: 100 }),
        (sections, newContent, timestamp, targetSeed) => {
          const markdown = buildMarkdown(sections);

          // Parse the original to get the baseline
          const originalParsed = parseMarkdownSections(markdown);

          // Pick a target section deterministically
          const targetIdx = targetSeed % sections.length;
          const targetHeading = sections[targetIdx].heading;

          const result = applyContentOperation(
            markdown,
            {
              action: 'append',
              content: newContent,
              section_target: targetHeading,
            },
            timestamp
          );

          expect(result.success).toBe(true);

          // All original section headings should be present in output
          for (const section of originalParsed.sections) {
            if (section.heading) {
              expect(result.content).toContain(section.heading);
            }
          }

          // All original non-empty, trimmed content lines should be present in output.
          // Note: applyAppend uses trimEnd() on the target section before appending,
          // so trailing whitespace on the last line of the target section may be removed.
          for (const section of originalParsed.sections) {
            const contentLines = section.content.split('\n');
            for (const line of contentLines) {
              const trimmed = line.trimEnd();
              if (trimmed) {
                expect(result.content).toContain(trimmed);
              }
            }
          }

          // The new content should also be present
          const newContentLines = newContent.split('\n');
          for (const line of newContentLines) {
            if (line.trim()) {
              expect(result.content).toContain(line);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
