/**
 * Unit Tests: Backlink Injection into Related Files
 *
 * Tests that when a new file is created with related_files, each related file
 * gets a backlink added correctly.
 *
 * Validates: Requirements 9.3
 */

import { describe, it, expect } from 'vitest';
import { injectBacklinks } from '../../src/components/wikilink-injector';

describe('Backlink injection', () => {
  it('when a new file is created with related_files, each related file gets a backlink added', () => {
    const existingContent = `# CNC Mill Research\n\nSome research notes about CNC mills.\n`;
    const newFilePath = '25_Real_Estate/CNC_Mill_Build/supplier-contacts.md';
    const newFileTitle = 'Supplier Contacts';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    expect(result).toContain(`[[${newFilePath}|${newFileTitle}]]`);
  });

  it('backlink is added under a "## Backlinks" section', () => {
    const existingContent = `# Research Notes\n\nContent about research.\n`;
    const newFilePath = '10_Work/Project_Alpha/requirements.md';
    const newFileTitle = 'Project Alpha Requirements';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    expect(result).toContain('## Backlinks');
    // The backlink should appear after the Backlinks heading
    const backlinksIndex = result.indexOf('## Backlinks');
    const backlinkIndex = result.indexOf(`[[${newFilePath}|${newFileTitle}]]`);
    expect(backlinkIndex).toBeGreaterThan(backlinksIndex);
  });

  it('existing content in related files is preserved', () => {
    const existingContent = `---
title: CNC Mill Research
tags: [cnc, research]
---

# CNC Mill Research

## Overview

This document covers CNC mill research.

## Suppliers

- Supplier A
- Supplier B

## Notes

Some additional notes here.
`;
    const newFilePath = '25_Real_Estate/CNC_Mill_Build/build-log.md';
    const newFileTitle = 'Build Log';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    // All original content should be preserved
    expect(result).toContain('# CNC Mill Research');
    expect(result).toContain('## Overview');
    expect(result).toContain('This document covers CNC mill research.');
    expect(result).toContain('## Suppliers');
    expect(result).toContain('- Supplier A');
    expect(result).toContain('- Supplier B');
    expect(result).toContain('## Notes');
    expect(result).toContain('Some additional notes here.');
    // Front matter preserved
    expect(result).toContain('title: CNC Mill Research');
    expect(result).toContain('tags: [cnc, research]');
    // Backlink added
    expect(result).toContain(`[[${newFilePath}|${newFileTitle}]]`);
  });

  it('duplicate backlinks are not added if the link already exists', () => {
    const existingContent = `# Research Notes

Some content.

## Backlinks

- [[25_Real_Estate/CNC_Mill_Build/supplier-contacts.md|Supplier Contacts]]
`;
    const newFilePath = '25_Real_Estate/CNC_Mill_Build/supplier-contacts.md';
    const newFileTitle = 'Supplier Contacts';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    // Should not add a duplicate
    const backlinkStr = `[[${newFilePath}|${newFileTitle}]]`;
    const occurrences = result.split(backlinkStr).length - 1;
    expect(occurrences).toBe(1);

    // Content should be unchanged
    expect(result).toBe(existingContent);
  });

  it('backlink injection on content with no existing Backlinks section creates one', () => {
    const existingContent = `# My Document

This is a document with no backlinks section.

## Some Section

Content here.
`;
    const newFilePath = '20_Personal/hobbies/woodworking.md';
    const newFileTitle = 'Woodworking Notes';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    // A new Backlinks section should be created
    expect(result).toContain('## Backlinks');
    expect(result).toContain(`- [[${newFilePath}|${newFileTitle}]]`);

    // Original content preserved
    expect(result).toContain('# My Document');
    expect(result).toContain('This is a document with no backlinks section.');
    expect(result).toContain('## Some Section');
    expect(result).toContain('Content here.');
  });

  it('appends to existing Backlinks section when one already exists', () => {
    const existingContent = `# Research Notes

Some content.

## Backlinks

- [[10_Work/project-a/notes.md|Project A Notes]]
`;
    const newFilePath = '20_Personal/ideas/brainstorm.md';
    const newFileTitle = 'Brainstorm Ideas';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    // Both backlinks should be present
    expect(result).toContain('[[10_Work/project-a/notes.md|Project A Notes]]');
    expect(result).toContain(`[[${newFilePath}|${newFileTitle}]]`);

    // Only one Backlinks heading
    const headingCount = (result.match(/## Backlinks/g) || []).length;
    expect(headingCount).toBe(1);
  });

  it('handles content with Backlinks section followed by another section', () => {
    const existingContent = `# Document

Content.

## Backlinks

- [[10_Work/existing.md|Existing Link]]

## Footer

Some footer content.
`;
    const newFilePath = '25_Real_Estate/new-file.md';
    const newFileTitle = 'New File';

    const result = injectBacklinks(existingContent, newFilePath, newFileTitle);

    // New backlink should be added within the Backlinks section
    expect(result).toContain(`[[${newFilePath}|${newFileTitle}]]`);
    // Footer section should still exist
    expect(result).toContain('## Footer');
    expect(result).toContain('Some footer content.');
    // Existing backlink preserved
    expect(result).toContain('[[10_Work/existing.md|Existing Link]]');
  });
});
