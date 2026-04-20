/**
 * Filing Plan Path Validator
 *
 * Validates file paths in Filing Plans against organic naming conventions
 * and security constraints. Ensures paths follow the NN_Name area prefix
 * pattern, contain only valid characters, and do not exceed depth limits.
 *
 * Validates: Requirements 1.3, 7.2
 */

import type { PathValidationResult } from '../types/filing-plan';

/**
 * Pattern for valid area prefixes: NN_Name (e.g., 00_System, 10_Work, 25_Real_Estate)
 * or the special _INBOX prefix.
 */
const AREA_PREFIX_PATTERN = /^\d{2}_[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Valid characters in a path: alphanumeric, underscores, hyphens, forward slashes, dots.
 */
const VALID_PATH_CHARS_PATTERN = /^[A-Za-z0-9_\-/.]+$/;

/**
 * Maximum allowed path depth (number of forward slashes).
 * A path like "10_Work/Project/Sub/Deep/More/file.md" has 5 slashes = 6 levels.
 */
const MAX_PATH_DEPTH = 6;

/**
 * Validate a file path against organic filing conventions and security constraints.
 *
 * Checks:
 * - Path is non-empty
 * - Path does not start or end with `/`
 * - Path contains only valid characters (alphanumeric, underscores, hyphens, forward slashes, dots)
 * - Path does not contain traversal sequences (`..`)
 * - Path depth does not exceed 6 levels
 * - Area prefix matches `NN_Name` or `_INBOX` pattern
 */
export function validateFilePath(path: string): PathValidationResult {
  const errors: string[] = [];

  // Reject empty paths
  if (!path || path.length === 0) {
    return { valid: false, errors: ['Path must not be empty'] };
  }

  // Reject paths starting with `/`
  if (path.startsWith('/')) {
    errors.push('Path must not start with /');
  }

  // Reject paths ending with `/`
  if (path.endsWith('/')) {
    errors.push('Path must not end with /');
  }

  // Reject path traversal sequences
  if (path.includes('..')) {
    errors.push('Path must not contain traversal sequences (..)');
  }

  // Reject double slashes (empty segments indicate malformed paths)
  if (path.includes('//')) {
    errors.push('Path must not contain double slashes (//)');
  }

  // Validate only valid characters
  if (!VALID_PATH_CHARS_PATTERN.test(path)) {
    errors.push(
      'Path contains invalid characters (only alphanumeric, underscores, hyphens, forward slashes, and dots are allowed)'
    );
  }

  // Reject path depth exceeding 6 levels
  const slashCount = path.split('/').length - 1;
  if (slashCount >= MAX_PATH_DEPTH) {
    errors.push(`Path depth must not exceed ${MAX_PATH_DEPTH} levels (found ${slashCount + 1})`);
  }

  // Validate area prefix matches NN_Name or _INBOX pattern
  const segments = path.split('/');
  const areaPrefix = segments[0];

  if (areaPrefix !== '_INBOX' && !AREA_PREFIX_PATTERN.test(areaPrefix)) {
    errors.push(
      'Area prefix must match NN_Name pattern (e.g., 00_System, 10_Work) or be _INBOX'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
