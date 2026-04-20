/**
 * Content Integrator — Pure functions for file content manipulation
 *
 * Performs section-level operations on Markdown files: append, update, delete.
 * All functions are pure (no I/O, no side effects).
 *
 * Handles:
 * - YAML front matter preservation
 * - ATX headings (# style) and setext headings (=== / --- underlines)
 * - Code blocks (fenced ``` or ~~~) — # inside code blocks are NOT headings
 * - Front matter containing --- inside YAML values
 * - Edge cases: no front matter, empty sections, nested headings
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * A parsed section of a markdown document.
 */
export interface MarkdownSection {
  /** The heading text (without the # prefix or underline) */
  heading: string;
  /** Heading level (1-6) */
  level: number;
  /** Content below the heading (up to the next heading of same or higher level) */
  content: string;
}

/**
 * Result of parsing a markdown document into structured sections.
 */
export interface ParsedMarkdown {
  /** Raw front matter string (including --- delimiters), empty string if none */
  frontMatter: string;
  /** Ordered array of sections */
  sections: MarkdownSection[];
}

/**
 * A content operation to apply to an existing markdown file.
 */
export interface ContentOperation {
  /** The action to perform */
  action: 'append' | 'update' | 'delete';
  /** New content to add (for append/update) */
  content?: string;
  /** Section heading to target (for update/delete) */
  section_target?: string;
  /** Heading to insert after (for append without section_target) */
  insert_after_heading?: string;
}

/**
 * Result of applying a content operation.
 */
export interface ContentResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The resulting markdown content */
  content: string;
  /** Warning messages (e.g., "section not found, appended at end") */
  warnings: string[];
  /** Error message if success=false */
  error?: string;
}

// ─── Front Matter Parsing ────────────────────────────────────────────────────

/**
 * Extract front matter from markdown content.
 * Handles YAML values that contain --- (e.g., quoted strings with dashes).
 *
 * Front matter must start at the very beginning of the file with ---.
 * The closing --- must be on its own line and not inside a YAML block scalar or quoted string.
 */
function extractFrontMatter(content: string): { frontMatter: string; body: string } {
  // Front matter must start at the very beginning
  if (!content.startsWith('---')) {
    return { frontMatter: '', body: content };
  }

  const lines = content.split('\n');

  // First line is the opening ---
  // Find the closing --- (must be exactly '---' on its own line, after the first line)
  let closingIndex = -1;
  let inBlockScalar = false;
  let blockIndent = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Track block scalars (| or >) in YAML
    if (!inBlockScalar) {
      // Check if this line starts a block scalar
      const blockMatch = line.match(/^\s*\w[\w\s]*:\s*[|>][-+]?\s*$/);
      if (blockMatch) {
        inBlockScalar = true;
        blockIndent = -1; // Will be determined by first content line
        continue;
      }
    } else {
      // Inside a block scalar — determine indent from first content line
      if (blockIndent === -1) {
        const indentMatch = line.match(/^(\s+)/);
        if (indentMatch) {
          blockIndent = indentMatch[1].length;
        } else if (line.trim() === '') {
          // Empty lines are part of block scalars
          continue;
        } else {
          // Non-indented non-empty line ends the block scalar
          inBlockScalar = false;
          blockIndent = -1;
        }
      } else {
        // Check if we've left the block scalar (less indent or no indent)
        const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (line.trim() !== '' && currentIndent < blockIndent) {
          inBlockScalar = false;
          blockIndent = -1;
        } else {
          continue;
        }
      }
    }

    // Check for closing ---
    if (!inBlockScalar && line.trimEnd() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    // No valid closing --- found; treat entire content as body
    return { frontMatter: '', body: content };
  }

  const frontMatterLines = lines.slice(0, closingIndex + 1);
  const bodyLines = lines.slice(closingIndex + 1);

  return {
    frontMatter: frontMatterLines.join('\n'),
    body: bodyLines.join('\n'),
  };
}

// ─── Markdown Section Parsing ────────────────────────────────────────────────

/**
 * Parse markdown content into front matter + sections array.
 *
 * Handles:
 * - ATX headings (# through ######)
 * - Setext headings (text followed by === or --- underlines)
 * - Fenced code blocks (``` or ~~~) — # inside code blocks are NOT headings
 * - Files with no headings (returns single section with empty heading)
 * - Empty sections (heading with no content before next heading)
 */
export function parseMarkdownSections(content: string): ParsedMarkdown {
  const { frontMatter, body } = extractFrontMatter(content);

  if (body.trim() === '') {
    return { frontMatter, sections: [] };
  }

  const lines = body.split('\n');
  const sections: MarkdownSection[] = [];

  let currentHeading = '';
  let currentLevel = 0;
  let currentContentLines: string[] = [];
  let inCodeBlock = false;
  let codeBlockFence = '';

  // Track whether we've started collecting content before any heading
  let hasStartedContent = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle fenced code blocks
    if (!inCodeBlock) {
      const fenceMatch = line.match(/^(\s{0,3})(```+|~~~+)/);
      if (fenceMatch) {
        inCodeBlock = true;
        codeBlockFence = fenceMatch[2].charAt(0);
        currentContentLines.push(line);
        hasStartedContent = true;
        continue;
      }
    } else {
      // Check for closing fence
      const closingFenceRegex = new RegExp(`^\\s{0,3}${codeBlockFence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}{${codeBlockFence.length},}\\s*$`);
      // Simpler: closing fence must use same char and at least same count
      const closeFenceMatch = line.match(/^(\s{0,3})(```+|~~~+)\s*$/);
      if (closeFenceMatch && closeFenceMatch[2].charAt(0) === codeBlockFence && closeFenceMatch[2].length >= codeBlockFence.length) {
        inCodeBlock = false;
        codeBlockFence = '';
      }
      currentContentLines.push(line);
      hasStartedContent = true;
      continue;
    }

    // Check for ATX heading (# through ######)
    const atxMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (atxMatch) {
      // Save previous section
      if (hasStartedContent || currentHeading !== '') {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: currentContentLines.join('\n'),
        });
      }
      currentHeading = atxMatch[2].trim();
      currentLevel = atxMatch[1].length;
      currentContentLines = [];
      hasStartedContent = true;
      continue;
    }

    // Check for setext heading (next line is === or ---)
    // The line must be non-empty text, and the next line must be all = or all -
    if (i + 1 < lines.length && line.trim() !== '') {
      const nextLine = lines[i + 1];
      const setextH1 = /^=+\s*$/.test(nextLine);
      const setextH2 = /^-+\s*$/.test(nextLine);

      if (setextH1 || setextH2) {
        // Save previous section
        if (hasStartedContent || currentHeading !== '') {
          sections.push({
            heading: currentHeading,
            level: currentLevel,
            content: currentContentLines.join('\n'),
          });
        }
        currentHeading = line.trim();
        currentLevel = setextH1 ? 1 : 2;
        currentContentLines = [];
        hasStartedContent = true;
        i++; // Skip the underline
        continue;
      }
    }

    // Regular content line
    currentContentLines.push(line);
    hasStartedContent = true;
  }

  // Push the last section
  if (hasStartedContent || currentHeading !== '') {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: currentContentLines.join('\n'),
    });
  }

  return { frontMatter, sections };
}

/**
 * Serialize front matter + sections back to a markdown string.
 *
 * Produces output that round-trips with parseMarkdownSections for well-formed input.
 */
export function serializeMarkdownSections(
  frontMatter: string,
  sections: MarkdownSection[]
): string {
  const parts: string[] = [];

  if (frontMatter) {
    parts.push(frontMatter);
  }

  for (const section of sections) {
    if (section.heading === '' && section.level === 0) {
      // Preamble content (before any heading)
      parts.push(section.content);
    } else {
      // Heading line
      const hashes = '#'.repeat(section.level);
      parts.push(`${hashes} ${section.heading}`);
      // Section content
      parts.push(section.content);
    }
  }

  return parts.join('\n');
}

// ─── Front Matter Manipulation ───────────────────────────────────────────────

/**
 * Update the `updated_at` field in front matter.
 * If the field exists, replace its value. If not, add it after `created_at`.
 * If no front matter exists, return it unchanged.
 */
function updateFrontMatterTimestamp(frontMatter: string, timestamp: string): string {
  if (!frontMatter) return frontMatter;

  const lines = frontMatter.split('\n');
  let updatedAtIndex = -1;
  let createdAtIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^\s*updated_at\s*:/)) {
      updatedAtIndex = i;
    }
    if (lines[i].match(/^\s*created_at\s*:/)) {
      createdAtIndex = i;
    }
  }

  if (updatedAtIndex !== -1) {
    // Replace existing updated_at
    lines[updatedAtIndex] = `updated_at: ${timestamp}`;
  } else if (createdAtIndex !== -1) {
    // Insert after created_at
    lines.splice(createdAtIndex + 1, 0, `updated_at: ${timestamp}`);
  } else {
    // Insert before closing ---
    const closingIdx = lines.lastIndexOf('---');
    if (closingIdx > 0) {
      lines.splice(closingIdx, 0, `updated_at: ${timestamp}`);
    }
  }

  return lines.join('\n');
}

// ─── Content Operations ──────────────────────────────────────────────────────

/**
 * Find the index of a section by heading text (case-insensitive match).
 * Matches against the heading text with or without the ## prefix.
 */
function findSectionIndex(sections: MarkdownSection[], target: string): number {
  // Normalize target: strip leading # characters and whitespace
  const normalizedTarget = target.replace(/^#+\s*/, '').trim().toLowerCase();

  for (let i = 0; i < sections.length; i++) {
    if (sections[i].heading.trim().toLowerCase() === normalizedTarget) {
      return i;
    }
  }
  return -1;
}

/**
 * Get the content length excluding front matter.
 */
function getBodyLength(content: string): number {
  const { body } = extractFrontMatter(content);
  return body.trim().length;
}

/**
 * Apply a content operation to an existing markdown file.
 *
 * Rules:
 * - Preserves front matter (everything between --- delimiters)
 * - Updates `updated_at` in front matter with operation timestamp
 * - For append: adds content under most relevant heading, or creates new section
 * - For update: replaces content under section_target heading
 * - For delete: removes content under section_target heading
 * - Rejects update if resulting content (excluding front matter) < 50% of original
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */
export function applyContentOperation(
  existingContent: string,
  operation: ContentOperation,
  timestamp: string
): ContentResult {
  const { action, section_target, insert_after_heading } = operation;
  const newContent = operation.content ?? '';

  switch (action) {
    case 'append':
      return applyAppend(existingContent, newContent, section_target, insert_after_heading, timestamp);
    case 'update':
      return applyUpdate(existingContent, newContent, section_target, timestamp);
    case 'delete':
      return applyDelete(existingContent, section_target, timestamp);
    default:
      return {
        success: false,
        content: existingContent,
        warnings: [],
        error: `Unknown action: ${action}`,
      };
  }
}

/**
 * Append content to an existing markdown file.
 *
 * Strategy:
 * 1. If section_target is specified, append under that heading
 * 2. If insert_after_heading is specified, insert after that heading's section
 * 3. Otherwise, append at the end of the document
 */
function applyAppend(
  existingContent: string,
  newContent: string,
  sectionTarget: string | undefined,
  insertAfterHeading: string | undefined,
  timestamp: string
): ContentResult {
  const parsed = parseMarkdownSections(existingContent);
  const warnings: string[] = [];

  let updatedFrontMatter = parsed.frontMatter;
  if (updatedFrontMatter) {
    updatedFrontMatter = updateFrontMatterTimestamp(updatedFrontMatter, timestamp);
  }

  const sections = [...parsed.sections];

  // Determine where to append
  const target = sectionTarget || insertAfterHeading;

  if (target) {
    const idx = findSectionIndex(sections, target);
    if (idx !== -1) {
      // Append content to the end of the target section's content
      const section = sections[idx];
      const existingTrimmed = section.content.trimEnd();
      sections[idx] = {
        ...section,
        content: existingTrimmed + '\n\n' + newContent + '\n',
      };
    } else {
      // Section not found — create a new section at the end
      warnings.push(`Section "${target}" not found, appended as new section at end`);
      // Determine heading level: default to 2
      const headingLevel = 2;
      sections.push({
        heading: target.replace(/^#+\s*/, '').trim(),
        level: headingLevel,
        content: '\n' + newContent + '\n',
      });
    }
  } else {
    // No target specified — append at the end of the last section
    if (sections.length > 0) {
      const lastIdx = sections.length - 1;
      const lastSection = sections[lastIdx];
      const existingTrimmed = lastSection.content.trimEnd();
      sections[lastIdx] = {
        ...lastSection,
        content: existingTrimmed + '\n\n' + newContent + '\n',
      };
    } else {
      // No sections at all — create a preamble section
      sections.push({
        heading: '',
        level: 0,
        content: '\n' + newContent + '\n',
      });
    }
  }

  const result = serializeMarkdownSections(updatedFrontMatter, sections);

  return {
    success: true,
    content: result,
    warnings,
  };
}

/**
 * Update (replace) content under a specific section heading.
 *
 * Rejects the operation if the resulting content (excluding front matter)
 * would be less than 50% of the original content length.
 */
function applyUpdate(
  existingContent: string,
  newContent: string,
  sectionTarget: string | undefined,
  timestamp: string
): ContentResult {
  if (!sectionTarget) {
    return {
      success: false,
      content: existingContent,
      warnings: [],
      error: 'Update operation requires a section_target',
    };
  }

  const parsed = parseMarkdownSections(existingContent);
  const sections = [...parsed.sections];

  const idx = findSectionIndex(sections, sectionTarget);
  if (idx === -1) {
    return {
      success: false,
      content: existingContent,
      warnings: [],
      error: `Section "${sectionTarget}" not found`,
    };
  }

  // Replace the section content
  const updatedSections = [...sections];
  updatedSections[idx] = {
    ...sections[idx],
    content: '\n' + newContent + '\n',
  };

  let updatedFrontMatter = parsed.frontMatter;
  if (updatedFrontMatter) {
    updatedFrontMatter = updateFrontMatterTimestamp(updatedFrontMatter, timestamp);
  }

  const result = serializeMarkdownSections(updatedFrontMatter, updatedSections);

  // Check destructive update guard: resulting body must be >= 50% of original body
  const originalBodyLength = getBodyLength(existingContent);
  const newBodyLength = getBodyLength(result);

  if (originalBodyLength > 0 && newBodyLength < originalBodyLength * 0.5) {
    return {
      success: false,
      content: existingContent,
      warnings: [],
      error: `Update rejected: resulting content (${newBodyLength} chars) is less than 50% of original (${originalBodyLength} chars)`,
    };
  }

  return {
    success: true,
    content: result,
    warnings: [],
  };
}

/**
 * Delete a section from the markdown file.
 *
 * If section_target is provided, removes that section (heading + content).
 * If the deletion leaves only front matter (empty body), logs a warning.
 */
function applyDelete(
  existingContent: string,
  sectionTarget: string | undefined,
  timestamp: string
): ContentResult {
  if (!sectionTarget) {
    return {
      success: false,
      content: existingContent,
      warnings: [],
      error: 'Delete operation requires a section_target',
    };
  }

  const parsed = parseMarkdownSections(existingContent);
  const sections = [...parsed.sections];
  const warnings: string[] = [];

  const idx = findSectionIndex(sections, sectionTarget);
  if (idx === -1) {
    return {
      success: false,
      content: existingContent,
      warnings: [],
      error: `Section "${sectionTarget}" not found`,
    };
  }

  // Remove the section
  const updatedSections = sections.filter((_, i) => i !== idx);

  let updatedFrontMatter = parsed.frontMatter;
  if (updatedFrontMatter) {
    updatedFrontMatter = updateFrontMatterTimestamp(updatedFrontMatter, timestamp);
  }

  // Check if deletion leaves empty file (only front matter)
  const hasContent = updatedSections.some(s => s.content.trim() !== '' || s.heading !== '');
  if (!hasContent) {
    warnings.push('Section delete leaves empty file (only front matter remaining). Consider deleting the entire file.');
  }

  const result = serializeMarkdownSections(updatedFrontMatter, updatedSections);

  return {
    success: true,
    content: result,
    warnings,
  };
}
