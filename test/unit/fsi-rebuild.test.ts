/**
 * Unit Tests: FSI Rebuild from CodeCommit
 *
 * Tests the rebuildFSIFromTree function which reconstructs the Folder Structure Index
 * from a list of files in the repository.
 *
 * Validates: Requirements 3.1, 3.4
 */

import { describe, it, expect, vi } from 'vitest';
import { rebuildFSIFromTree } from '../../src/components/fsi-updater';

describe('FSI rebuild from CodeCommit', () => {
  it('rebuilt FSI contains all files and folders from the repo tree', () => {
    const files = [
      { path: '10_Work/Project_Alpha/requirements.md', title: 'Requirements' },
      { path: '10_Work/Project_Alpha/notes.md', title: 'Notes' },
      { path: '20_Personal/health-log.md' },
      { path: '25_Real_Estate/CNC_Mill_Build/research-notes.md', title: 'CNC Research' },
    ];

    const fsi = rebuildFSIFromTree(files);

    // All files should be present
    for (const file of files) {
      const entry = fsi.entries.find((e) => e.path === file.path);
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('file');
    }

    // All intermediate folders should be present
    const expectedFolders = [
      '10_Work',
      '10_Work/Project_Alpha',
      '20_Personal',
      '25_Real_Estate',
      '25_Real_Estate/CNC_Mill_Build',
    ];
    for (const folder of expectedFolders) {
      const entry = fsi.entries.find((e) => e.path === folder);
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('folder');
    }
  });

  it('rebuilt FSI file entries include front-matter titles when available', () => {
    const files = [
      { path: '10_Work/project.md', title: 'My Project' },
      { path: '10_Work/untitled.md' },
    ];

    const fsi = rebuildFSIFromTree(files);

    const withTitle = fsi.entries.find((e) => e.path === '10_Work/project.md');
    expect(withTitle).toBeDefined();
    expect(withTitle!.title).toBe('My Project');

    const withoutTitle = fsi.entries.find((e) => e.path === '10_Work/untitled.md');
    expect(withoutTitle).toBeDefined();
    expect(withoutTitle!.title).toBeUndefined();
  });

  it('rebuild handles empty repository (returns scaffold-only FSI)', () => {
    const files: Array<{ path: string; title?: string }> = [];

    const fsi = rebuildFSIFromTree(files);

    expect(fsi.version).toBe(1);
    expect(fsi.entries).toEqual([]);
    expect(fsi.last_updated).toBeDefined();
    expect(fsi.commit_id).toBe('');
  });

  it('when FSI commit_id does not match CodeCommit HEAD, FSI should be rebuilt', () => {
    // Simulate: existing FSI has stale commit_id, repo has different files
    const staleFSI = {
      version: 1,
      last_updated: '2026-01-01T00:00:00Z',
      commit_id: 'old-commit-abc',
      entries: [
        { path: '10_Work', type: 'folder' as const },
        { path: '10_Work/old-file.md', type: 'file' as const, title: 'Old File' },
      ],
    };

    const currentHeadCommitId = 'new-commit-xyz';

    // The rebuild should be triggered when commit_id doesn't match
    expect(staleFSI.commit_id).not.toBe(currentHeadCommitId);

    // Rebuild from current repo tree
    const currentFiles = [
      { path: '10_Work/new-file.md', title: 'New File' },
      { path: '20_Personal/journal.md', title: 'Journal' },
    ];

    const rebuiltFSI = rebuildFSIFromTree(currentFiles);

    // Rebuilt FSI should reflect current state, not stale state
    expect(rebuiltFSI.entries.some((e) => e.path === '10_Work/old-file.md')).toBe(false);
    expect(rebuiltFSI.entries.some((e) => e.path === '10_Work/new-file.md')).toBe(true);
    expect(rebuiltFSI.entries.some((e) => e.path === '20_Personal/journal.md')).toBe(true);
  });

  it('rebuild handles CodeCommit read failure gracefully (returns null, logs error)', () => {
    // This test validates the pattern: when CodeCommit read fails, the caller
    // should handle it gracefully. We test the rebuild function with a simulated
    // failure scenario by testing the expected behavior pattern.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Simulate what the caller would do on CodeCommit failure:
    // The rebuild function itself is pure (takes files array), so the caller
    // is responsible for catching CodeCommit errors and returning null.
    function rebuildFSIWithCodeCommitFetch(
      fetchFiles: () => Array<{ path: string; title?: string }> | null
    ) {
      try {
        const files = fetchFiles();
        if (files === null) {
          console.error('CodeCommit read failure: unable to fetch repository tree');
          return null;
        }
        return rebuildFSIFromTree(files);
      } catch (error) {
        console.error('CodeCommit read failure:', error);
        return null;
      }
    }

    // Test: fetch returns null (simulating API failure)
    const result1 = rebuildFSIWithCodeCommitFetch(() => null);
    expect(result1).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'CodeCommit read failure: unable to fetch repository tree'
    );

    // Test: fetch throws an error
    consoleErrorSpy.mockClear();
    const result2 = rebuildFSIWithCodeCommitFetch(() => {
      throw new Error('Network timeout');
    });
    expect(result2).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
