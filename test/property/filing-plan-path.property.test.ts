/**
 * Property-Based Tests: Filing Plan Path Validation
 *
 * Feature: organic-knowledge-filing, Property 2: Filing Plan path validation
 *
 * **Validates: Requirements 1.3, 7.2**
 *
 * For any Filing Plan with intent: "capture", the file_path field SHALL match the organic
 * naming conventions (area prefix matches NN_Name or _INBOX pattern, path contains only
 * valid characters: alphanumeric, underscores, hyphens, forward slashes, and dots),
 * SHALL NOT contain path traversal sequences (..),
 * and path depth SHALL NOT exceed 6 levels.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateFilePath } from '../../src/components/filing-plan-path-validator';

// --- Arbitraries ---

/** Generate a valid area prefix: NN_Name pattern */
const validAreaPrefix: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('')), {
      minLength: 1,
      maxLength: 10,
    })
  )
  .map(([num, name]) => `${num.toString().padStart(2, '0')}_${name}`);

/** Generate a valid path segment (alphanumeric, underscores, hyphens, dots) */
const validSegment: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.'.split('')
  ),
  { minLength: 1, maxLength: 20 }
);

/** Generate a valid organic file path (1-5 segments after area prefix) */
const validOrganicPath: fc.Arbitrary<string> = fc
  .tuple(
    fc.oneof(validAreaPrefix, fc.constant('_INBOX')),
    fc.array(validSegment, { minLength: 1, maxLength: 4 })
  )
  .map(([area, segments]) => [area, ...segments].join('/'));

/** Generate a path with traversal attack */
const traversalPath: fc.Arbitrary<string> = fc
  .tuple(validAreaPrefix, fc.array(validSegment, { minLength: 0, maxLength: 2 }))
  .map(([area, segments]) => {
    const parts = [area, ...segments, '..', 'etc', 'passwd'];
    return parts.join('/');
  });

/** Generate a path exceeding depth limit (7+ levels) */
const deepPath: fc.Arbitrary<string> = fc
  .tuple(validAreaPrefix, fc.array(validSegment, { minLength: 6, maxLength: 10 }))
  .map(([area, segments]) => [area, ...segments].join('/'));

/** Generate a path with invalid characters */
const invalidCharPath: fc.Arbitrary<string> = fc
  .tuple(
    validAreaPrefix,
    fc.array(
      fc.stringOf(
        fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz @#$%^&*()+=[]{}|\\:;"\'<>,?!~`'.split('')),
        { minLength: 1, maxLength: 15 }
      ),
      { minLength: 1, maxLength: 3 }
    )
  )
  .map(([area, segments]) => [area, ...segments].join('/'))
  .filter((path) => !/^[A-Za-z0-9_\-/.]+$/.test(path));

/** Generate a path with invalid area prefix (no NN_ pattern, not _INBOX) */
const invalidPrefixPath: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
      { minLength: 2, maxLength: 10 }
    ),
    fc.array(validSegment, { minLength: 1, maxLength: 3 })
  )
  .map(([prefix, segments]) => [prefix, ...segments].join('/'))
  .filter((path) => {
    const area = path.split('/')[0];
    return area !== '_INBOX' && !/^\d{2}_[A-Za-z][A-Za-z0-9_]*$/.test(area);
  });

describe('Property 2: Filing Plan path validation', () => {
  it('should accept valid organic paths with NN_Name prefix', () => {
    fc.assert(
      fc.property(validOrganicPath, (path) => {
        const result = validateFilePath(path);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });

  it('should accept paths with _INBOX prefix', () => {
    fc.assert(
      fc.property(
        fc.array(validSegment, { minLength: 1, maxLength: 4 }),
        (segments) => {
          const path = ['_INBOX', ...segments].join('/');
          const result = validateFilePath(path);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject paths containing traversal sequences (..)', () => {
    fc.assert(
      fc.property(traversalPath, (path) => {
        const result = validateFilePath(path);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('traversal'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should reject paths exceeding 6 levels of depth', () => {
    fc.assert(
      fc.property(deepPath, (path) => {
        const result = validateFilePath(path);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('depth'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should reject paths with invalid characters', () => {
    fc.assert(
      fc.property(invalidCharPath, (path) => {
        const result = validateFilePath(path);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('invalid characters'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should reject paths with invalid area prefix', () => {
    fc.assert(
      fc.property(invalidPrefixPath, (path) => {
        const result = validateFilePath(path);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Area prefix'))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should enforce naming convention: area prefix matches NN_Name or _INBOX', () => {
    fc.assert(
      fc.property(
        validOrganicPath,
        (path) => {
          const area = path.split('/')[0];
          const isValidArea =
            area === '_INBOX' || /^\d{2}_[A-Za-z][A-Za-z0-9_]*$/.test(area);
          expect(isValidArea).toBe(true);

          const result = validateFilePath(path);
          expect(result.errors.some((e) => e.includes('Area prefix'))).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
