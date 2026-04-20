/**
 * Property-Based Tests: Content Integrator Front Matter Preservation
 *
 * Feature: organic-knowledge-filing, Property 5: Content Integrator front matter preservation
 *
 * **Validates: Requirements 8.4, 8.5**
 *
 * For any Markdown file with valid YAML front matter and any append or update operation,
 * the output SHALL preserve all existing front matter fields unchanged EXCEPT `updated_at`,
 * which SHALL be set to the operation's timestamp.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  parseMarkdownSections,
  applyContentOperation,
} from '../../src/components/content-integrator';

// --- Helpers ---

/** Parse YAML front matter fields into a key-value map (simple flat parsing) */
function parseFrontMatterFields(frontMatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!frontMatter) return fields;

  const lines = frontMatter.split('\n');
  // Skip opening and closing ---
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimEnd() === '---') break;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fields[key] = value;
    }
  }
  return fields;
}

// --- Arbitraries ---

/** Generate a simple YAML-safe string value (no colons, no newlines, no quotes) */
const yamlValueArb = fc
  .stringMatching(/^[A-Za-z0-9 _-]{1,30}$/)
  .filter((s) => s.trim().length > 0);

/** Generate a YAML field key */
const yamlKeyArb = fc
  .stringMatching(/^[a-z][a-z0-9_]{1,15}$/)
  .filter((s) => s !== 'updated_at');

/** Generate random front matter with various fields */
const frontMatterArb = fc
  .record({
    title: yamlValueArb,
    created_at: fc
      .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
      .map((d) => d.toISOString()),
    extraFields: fc.array(
      fc.tuple(yamlKeyArb, yamlValueArb),
      { minLength: 0, maxLength: 4 }
    ),
    hasUpdatedAt: fc.boolean(),
  })
  .map(({ title, created_at, extraFields, hasUpdatedAt }) => {
    const lines = ['---'];
    lines.push(`title: ${title}`);
    lines.push(`created_at: ${created_at}`);
    if (hasUpdatedAt) {
      lines.push(`updated_at: 2020-01-01T00:00:00.000Z`);
    }
    // Deduplicate extra field keys
    const usedKeys = new Set(['title', 'created_at', 'updated_at']);
    for (const [key, value] of extraFields) {
      if (!usedKeys.has(key)) {
        usedKeys.add(key);
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push('---');
    return lines.join('\n');
  });

/** Generate a heading text */
const headingTextArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9 ]{2,20}$/)
  .filter((s) => s.trim().length > 0);

/** Generate section body content */
const sectionBodyArb = fc
  .array(
    fc.stringMatching(/^[A-Za-z0-9 .,;:!?()-]{1,50}$/).filter(
      (line) => !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('===')
    ),
    { minLength: 1, maxLength: 4 }
  )
  .map((lines) => lines.join('\n'));

/** Generate a markdown file with front matter and sections */
const markdownWithFrontMatterArb = fc
  .record({
    frontMatter: frontMatterArb,
    sections: fc
      .array(
        fc.record({
          heading: headingTextArb,
          level: fc.integer({ min: 2, max: 4 }),
          body: sectionBodyArb,
        }),
        { minLength: 1, maxLength: 4 }
      )
      .map((sections) => {
        // Ensure unique headings
        const usedHeadings = new Set<string>();
        return sections.filter((s) => {
          const lower = s.heading.toLowerCase();
          if (usedHeadings.has(lower)) return false;
          usedHeadings.add(lower);
          return true;
        });
      })
      .filter((sections) => sections.length >= 1),
  })
  .map(({ frontMatter, sections }) => {
    const parts = [frontMatter];
    for (const section of sections) {
      const hashes = '#'.repeat(section.level);
      parts.push(`${hashes} ${section.heading}`);
      parts.push(section.body);
      parts.push('');
    }
    return { markdown: parts.join('\n'), frontMatter, sections };
  });

/** Generate new content for append/update */
const newContentArb = fc
  .array(
    fc.stringMatching(/^[A-Za-z0-9 .,;:!?()-]{1,40}$/),
    { minLength: 1, maxLength: 3 }
  )
  .map((lines) => lines.join('\n'));

const timestampArb = fc
  .date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString());

// --- Tests ---

describe('Property 5: Content Integrator front matter preservation', () => {
  it('append operation preserves all front matter fields except updated_at', () => {
    fc.assert(
      fc.property(
        markdownWithFrontMatterArb,
        newContentArb,
        timestampArb,
        ({ markdown, frontMatter, sections }, newContent, timestamp) => {
          const targetHeading = sections[0].heading;

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

          // Parse front matter from input and output
          const inputFields = parseFrontMatterFields(frontMatter);
          const outputParsed = parseMarkdownSections(result.content);
          const outputFields = parseFrontMatterFields(outputParsed.frontMatter);

          // All input fields (except updated_at) should be preserved
          for (const [key, value] of Object.entries(inputFields)) {
            if (key === 'updated_at') continue;
            expect(outputFields[key]).toBe(value);
          }

          // updated_at should be set to the operation timestamp
          expect(outputFields['updated_at']).toBe(timestamp);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('update operation preserves all front matter fields except updated_at', () => {
    fc.assert(
      fc.property(
        markdownWithFrontMatterArb,
        newContentArb,
        timestampArb,
        ({ markdown, frontMatter, sections }, newContent, timestamp) => {
          const targetHeading = sections[0].heading;

          const result = applyContentOperation(
            markdown,
            {
              action: 'update',
              content: newContent,
              section_target: targetHeading,
            },
            timestamp
          );

          // Update may be rejected if too destructive — only check when successful
          if (!result.success) return;

          // Parse front matter from input and output
          const inputFields = parseFrontMatterFields(frontMatter);
          const outputParsed = parseMarkdownSections(result.content);
          const outputFields = parseFrontMatterFields(outputParsed.frontMatter);

          // All input fields (except updated_at) should be preserved
          for (const [key, value] of Object.entries(inputFields)) {
            if (key === 'updated_at') continue;
            expect(outputFields[key]).toBe(value);
          }

          // updated_at should be set to the operation timestamp
          expect(outputFields['updated_at']).toBe(timestamp);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('updated_at is set to the operation timestamp even when not previously present', () => {
    fc.assert(
      fc.property(
        markdownWithFrontMatterArb,
        newContentArb,
        timestampArb,
        ({ markdown, sections }, newContent, timestamp) => {
          // Remove any existing updated_at from the markdown
          const markdownWithoutUpdatedAt = markdown
            .split('\n')
            .filter((line) => !line.startsWith('updated_at:'))
            .join('\n');

          const targetHeading = sections[0].heading;

          const result = applyContentOperation(
            markdownWithoutUpdatedAt,
            {
              action: 'append',
              content: newContent,
              section_target: targetHeading,
            },
            timestamp
          );

          expect(result.success).toBe(true);

          const outputParsed = parseMarkdownSections(result.content);
          const outputFields = parseFrontMatterFields(outputParsed.frontMatter);

          // updated_at should be set to the operation timestamp
          expect(outputFields['updated_at']).toBe(timestamp);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('front matter delimiters (---) are preserved in output', () => {
    fc.assert(
      fc.property(
        markdownWithFrontMatterArb,
        newContentArb,
        timestampArb,
        ({ markdown, sections }, newContent, timestamp) => {
          const targetHeading = sections[0].heading;

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

          // Output should start with --- and contain closing ---
          expect(result.content.startsWith('---\n')).toBe(true);
          const lines = result.content.split('\n');
          const closingIdx = lines.indexOf('---', 1);
          expect(closingIdx).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
