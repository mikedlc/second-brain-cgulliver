/**
 * Property-Based Tests: Folder Structure Index Update Consistency
 *
 * Feature: organic-knowledge-filing, Property 7: Folder Structure Index update consistency
 *
 * **Validates: Requirements 3.2, 11.2, 11.5, 11.6, 11.7**
 *
 * For any valid Folder Structure Index and any file operation (create, delete, or move):
 * - After a create at path P, the FSI SHALL contain P and all intermediate folder paths.
 * - After a delete of path P, the FSI SHALL NOT contain P. If P was the only file in its
 *   parent folder, the parent folder entry SHALL also be removed.
 * - After a move from P to Q, the FSI SHALL NOT contain P, SHALL contain Q and all
 *   intermediate folders for Q, and SHALL remove empty parent folders of P.
 * - The FSI input SHALL never be mutated (input !== output reference).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  applyCreate,
  applyDelete,
  applyMove,
  getIntermediateFolders,
  isFolderEmpty,
} from '../../src/components/fsi-updater';
import { FolderStructureIndex, FSIEntry } from '../../src/types/folder-structure-index';

// --- Arbitraries ---

/** Generate a valid area prefix */
const areaPrefixArb = fc.oneof(
  fc.constant('10_Work'),
  fc.constant('20_Personal'),
  fc.constant('25_Real_Estate'),
  fc.constant('30_Archive'),
  fc.constant('_INBOX')
);

/** Generate a valid subfolder name */
const subfolderNameArb = fc.stringMatching(/^[A-Z][a-z_]{2,10}$/).filter((s) => s.length >= 3);

/** Generate a valid filename */
const filenameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,12}\.md$/).filter((s) => s.length >= 6);

/** Generate a valid file path (1-3 levels of subfolders + filename) */
const filePathArb = fc
  .tuple(
    areaPrefixArb,
    fc.array(subfolderNameArb, { minLength: 0, maxLength: 2 }),
    filenameArb
  )
  .map(([area, subfolders, filename]) => [area, ...subfolders, filename].join('/'));

/** Generate a consistent FSI from a set of file paths */
function buildFSIFromPaths(filePaths: string[]): FolderStructureIndex {
  const entries: FSIEntry[] = [];
  const seen = new Set<string>();

  for (const filePath of filePaths) {
    // Add intermediate folders
    const folders = getIntermediateFolders(filePath);
    for (const folder of folders) {
      if (!seen.has(folder)) {
        seen.add(folder);
        entries.push({ path: folder, type: 'folder' });
      }
    }
    // Add file
    if (!seen.has(filePath)) {
      seen.add(filePath);
      entries.push({ path: filePath, type: 'file' });
    }
  }

  return {
    version: 1,
    last_updated: '2026-01-01T00:00:00Z',
    commit_id: 'abc123',
    entries,
  };
}

/** Generate a valid FSI with 1-5 files */
const fsiArb = fc
  .array(filePathArb, { minLength: 1, maxLength: 5 })
  .map((paths) => {
    // Deduplicate paths
    const unique = [...new Set(paths)];
    return buildFSIFromPaths(unique);
  });

/** Generate a new file path that is NOT already in the FSI */
const newFilePathArb = (fsi: FolderStructureIndex) =>
  filePathArb.filter((path) => !fsi.entries.some((e) => e.path === path));

// --- Tests ---

describe('Property 7: Folder Structure Index update consistency', () => {
  it('create adds path and all intermediate folders', () => {
    fc.assert(
      fc.property(fsiArb, filePathArb, (fsi, newPath) => {
        const result = applyCreate(fsi, newPath);

        // The new path should be in the result
        expect(result.entries.some((e) => e.path === newPath && e.type === 'file')).toBe(true);

        // All intermediate folders should be present
        const folders = getIntermediateFolders(newPath);
        for (const folder of folders) {
          expect(result.entries.some((e) => e.path === folder && e.type === 'folder')).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('delete removes path and empty parent folders', () => {
    fc.assert(
      fc.property(fsiArb, (fsi) => {
        // Pick a file entry to delete
        const fileEntries = fsi.entries.filter((e) => e.type === 'file');
        if (fileEntries.length === 0) return; // skip if no files

        const targetFile = fileEntries[0];
        const result = applyDelete(fsi, targetFile.path);

        // The deleted file should NOT be in the result
        expect(result.entries.some((e) => e.path === targetFile.path)).toBe(false);

        // Check parent folders: if they were the only child, they should be removed
        const parentFolders = getIntermediateFolders(targetFile.path);
        for (let i = parentFolders.length - 1; i >= 0; i--) {
          const folder = parentFolders[i];
          const folderInResult = result.entries.some((e) => e.path === folder);

          if (folderInResult) {
            // If the folder is still present, it must have other children
            expect(isFolderEmpty({ ...result, entries: result.entries }, folder)).toBe(false);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('move removes source, adds dest + intermediates, removes empty source parents', () => {
    fc.assert(
      fc.property(fsiArb, filePathArb, (fsi, destPath) => {
        // Pick a file entry to move
        const fileEntries = fsi.entries.filter((e) => e.type === 'file');
        if (fileEntries.length === 0) return; // skip if no files

        const sourceFile = fileEntries[0];

        // Skip if source and dest are the same
        if (sourceFile.path === destPath) return;

        const result = applyMove(fsi, sourceFile.path, destPath);

        // Source should NOT be in the result
        expect(result.entries.some((e) => e.path === sourceFile.path)).toBe(false);

        // Destination should be in the result
        expect(result.entries.some((e) => e.path === destPath && e.type === 'file')).toBe(true);

        // All intermediate folders for dest should be present
        const destFolders = getIntermediateFolders(destPath);
        for (const folder of destFolders) {
          expect(result.entries.some((e) => e.path === folder && e.type === 'folder')).toBe(true);
        }

        // Empty source parent folders should be removed
        const sourceFolders = getIntermediateFolders(sourceFile.path);
        for (const folder of sourceFolders) {
          const folderInResult = result.entries.some((e) => e.path === folder);
          if (folderInResult) {
            expect(isFolderEmpty({ ...result, entries: result.entries }, folder)).toBe(false);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('FSI is never mutated (input !== output reference)', () => {
    fc.assert(
      fc.property(fsiArb, filePathArb, filePathArb, (fsi, path1, path2) => {
        // Deep copy the original entries for comparison
        const originalEntries = JSON.parse(JSON.stringify(fsi.entries));

        // Apply create
        const afterCreate = applyCreate(fsi, path1);
        expect(afterCreate).not.toBe(fsi);
        expect(afterCreate.entries).not.toBe(fsi.entries);
        expect(fsi.entries).toEqual(originalEntries);

        // Apply delete (on a file that exists)
        const fileEntries = fsi.entries.filter((e) => e.type === 'file');
        if (fileEntries.length > 0) {
          const afterDelete = applyDelete(fsi, fileEntries[0].path);
          expect(afterDelete).not.toBe(fsi);
          expect(afterDelete.entries).not.toBe(fsi.entries);
          expect(fsi.entries).toEqual(originalEntries);
        }

        // Apply move
        if (fileEntries.length > 0 && fileEntries[0].path !== path2) {
          const afterMove = applyMove(fsi, fileEntries[0].path, path2);
          expect(afterMove).not.toBe(fsi);
          expect(afterMove.entries).not.toBe(fsi.entries);
          expect(fsi.entries).toEqual(originalEntries);
        }
      }),
      { numRuns: 100 }
    );
  });
});
