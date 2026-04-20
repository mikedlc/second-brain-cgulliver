/**
 * Property-Based Tests: Wikilinks Generated for Related Files
 *
 * Feature: organic-knowledge-filing, Property 11: Wikilinks generated for related files
 *
 * **Validates: Requirements 9.2**
 *
 * For any Filing Plan with action: "create" and a non-empty integration_metadata.related_files
 * array, the content written to the Knowledge Repository SHALL contain a wikilink (in [[path]]
 * or [[path|title]] format) for each entry in related_files.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { injectWikilinks } from '../../src/components/wikilink-injector';

// --- Arbitraries ---

/** Generate a random markdown content string */
const markdownContent: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.constant('# Heading\n\nSome paragraph text.\n'),
      fc.constant('## Section\n\nDetails here.\n'),
      fc.constant('Some plain text content.\n'),
      fc.constant('- list item one\n- list item two\n'),
      fc.constant('```\ncode block\n```\n'),
      fc.string({ minLength: 1, maxLength: 100 }).map((s) => `${s}\n`)
    ),
    { minLength: 1, maxLength: 5 }
  )
  .map((parts) => parts.join('\n'));

/** Generate a valid file path for related_files */
const filePath: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('10_Work', '20_Personal', '25_Real_Estate', '30_Archive', '_INBOX'),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 1,
      maxLength: 20,
    }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
      minLength: 1,
      maxLength: 20,
    })
  )
  .map(([area, folder, file]) => `${area}/${folder}/${file}.md`);

/** Generate a non-empty array of unique related file paths */
const relatedFilesNonEmpty: fc.Arbitrary<string[]> = fc
  .uniqueArray(filePath, { minLength: 1, maxLength: 8 })
  .filter((arr) => arr.length > 0);

describe('Property 11: Wikilinks generated for related files', () => {
  it('output contains a [[path]] wikilink for each entry in related_files', () => {
    fc.assert(
      fc.property(markdownContent, relatedFilesNonEmpty, (content, relatedFiles) => {
        const result = injectWikilinks(content, relatedFiles);

        for (const file of relatedFiles) {
          expect(result).toContain(`[[${file}]]`);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('empty related_files returns content unchanged', () => {
    fc.assert(
      fc.property(markdownContent, (content) => {
        const result = injectWikilinks(content, []);
        expect(result).toBe(content);
      }),
      { numRuns: 100 }
    );
  });

  it('"## Related" section is present in output when related_files is non-empty', () => {
    fc.assert(
      fc.property(markdownContent, relatedFilesNonEmpty, (content, relatedFiles) => {
        const result = injectWikilinks(content, relatedFiles);
        expect(result).toContain('## Related');
      }),
      { numRuns: 100 }
    );
  });

  it('does not duplicate wikilinks when "## Related" section already exists with some links', () => {
    fc.assert(
      fc.property(relatedFilesNonEmpty, (relatedFiles) => {
        // Create content that already has a Related section with the first file
        const existingContent = `# My Note\n\nSome content.\n\n## Related\n\n- [[${relatedFiles[0]}]]\n`;

        const result = injectWikilinks(existingContent, relatedFiles);

        // Count occurrences of the first file's wikilink — should be exactly 1
        const firstLink = `[[${relatedFiles[0]}]]`;
        const occurrences = result.split(firstLink).length - 1;
        expect(occurrences).toBe(1);

        // All other files should still be present
        for (const file of relatedFiles) {
          expect(result).toContain(`[[${file}]]`);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('original content is preserved in the output', () => {
    fc.assert(
      fc.property(markdownContent, relatedFilesNonEmpty, (content, relatedFiles) => {
        const result = injectWikilinks(content, relatedFiles);

        // The original content (trimmed) should appear in the result
        expect(result).toContain(content.trimEnd());
      }),
      { numRuns: 100 }
    );
  });
});
