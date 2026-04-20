/**
 * Unit Tests: Filing Executor
 *
 * Tests each action type (create, append, update, delete, move) with mocked CodeCommit.
 * Tests fallback, rejection, FSI update, and FSI failure scenarios.
 *
 * Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7, 7.9, 7.10, 11.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mock ───────────────────────────────────────────────────────────────

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-codecommit', () => {
  class MockCodeCommitClient {
    send = mockSend;
  }
  class GetBranchCommand {
    constructor(public input: any) {}
  }
  class GetFileCommand {
    constructor(public input: any) {}
  }
  class CreateCommitCommand {
    constructor(public input: any) {}
  }
  class FileDoesNotExistException extends Error {
    override name = 'FileDoesNotExistException';
    constructor() {
      super('File does not exist');
    }
  }
  class ParentCommitIdOutdatedException extends Error {
    override name = 'ParentCommitIdOutdatedException';
    constructor() {
      super('Parent commit ID outdated');
    }
  }
  return {
    CodeCommitClient: MockCodeCommitClient,
    GetBranchCommand,
    GetFileCommand,
    CreateCommitCommand,
    FileDoesNotExistException,
    ParentCommitIdOutdatedException,
  };
});

import { executeFilingPlan } from '../../src/components/filing-executor';
import type { FilingPlan } from '../../src/types/filing-plan';
import type { FolderStructureIndex } from '../../src/types/folder-structure-index';
import { FileDoesNotExistException } from '@aws-sdk/client-codecommit';

// ── Helpers ──────────────────────────────────────────────────────────────────

function basePlan(overrides: Partial<FilingPlan> = {}): FilingPlan {
  return {
    intent: 'capture',
    intent_confidence: 0.95,
    file_path: '10_Work/notes.md',
    action: 'create',
    title: 'Notes',
    content: '# Notes\n\nSome content here.',
    reasoning: 'New notes file',
    integration_metadata: {
      related_files: [],
      content_disposition: 'new_topic',
      confidence: 0.9,
    },
    ...overrides,
  };
}

function baseFSI(): FolderStructureIndex {
  return {
    version: 1,
    last_updated: '2026-01-01T00:00:00Z',
    commit_id: 'abc123',
    entries: [{ path: '10_Work', type: 'folder' }],
  };
}

const baseConfig = {
  repositoryName: 'test-repo',
  branchName: 'main',
  actorId: 'user-123',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Filing Executor — action types', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('create action', () => {
    it('creates a new file when path does not exist', async () => {
      mockSend
        // GetFile: file does not exist
        .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
        // GetBranch for commit
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        // CreateCommit
        .mockResolvedValueOnce({ commitId: 'commit-1' });

      const result = await executeFilingPlan(basePlan(), baseConfig, baseFSI());

      expect(result.success).toBe(true);
      expect(result.commitId).toBe('commit-1');
    });
  });

  describe('append action', () => {
    it('appends content to an existing file', async () => {
      const existingContent = '---\ntitle: Existing\n---\n\n# Existing\n\nOld content.\n';

      mockSend
        // GetFile: file exists (read for append)
        .mockResolvedValueOnce({ fileContent: Buffer.from(existingContent) })
        // GetBranch for commit
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        // CreateCommit
        .mockResolvedValueOnce({ commitId: 'commit-2' });

      const plan = basePlan({ action: 'append', content: 'New appended content.' });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(true);
      expect(result.commitId).toBe('commit-2');
    });

    it('falls back to create when file does not exist', async () => {
      mockSend
        // GetFile in executeAppend: file does not exist → returns null
        .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
        // GetFile in executeCreate: file does not exist → creates normally
        .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
        // GetBranch for commit
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        // CreateCommit
        .mockResolvedValueOnce({ commitId: 'commit-3' });

      const plan = basePlan({ action: 'append' });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(true);
      // The warning is added by executeAppend before calling executeCreate
      // but executeCreate is called with action: 'create' so it won't add the warning itself.
      // The warning comes from executeAppend's fallback logic.
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('falling back to create')
      );
    });
  });

  describe('update action', () => {
    it('updates a section of an existing file', async () => {
      const existingContent =
        '---\ntitle: Doc\n---\n\n# Doc\n\n## Section A\n\nOld section content.\n\n## Section B\n\nOther content.\n';

      mockSend
        // GetFile: file exists
        .mockResolvedValueOnce({ fileContent: Buffer.from(existingContent) })
        // GetBranch for commit
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        // CreateCommit
        .mockResolvedValueOnce({ commitId: 'commit-4' });

      const plan = basePlan({
        action: 'update',
        section_target: 'Section A',
        content: 'Updated section content.',
      });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(true);
      expect(result.commitId).toBe('commit-4');
    });
  });

  describe('delete action', () => {
    it('whole-file delete returns confirmationRequired', async () => {
      const plan = basePlan({ action: 'delete' });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(true);
      expect(result.confirmationRequired).toBe(true);
    });

    it('section delete executes immediately', async () => {
      const existingContent =
        '---\ntitle: Doc\n---\n\n# Doc\n\n## Keep\n\nKeep this.\n\n## Remove\n\nRemove this.\n';

      mockSend
        // GetFile: file exists
        .mockResolvedValueOnce({ fileContent: Buffer.from(existingContent) })
        // GetBranch for commit
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        // CreateCommit
        .mockResolvedValueOnce({ commitId: 'commit-5' });

      const plan = basePlan({ action: 'delete', section_target: 'Remove' });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(true);
      expect(result.commitId).toBe('commit-5');
      expect(result.confirmationRequired).toBeUndefined();
    });
  });

  describe('move action', () => {
    it('moves a file from source to destination', async () => {
      const sourceContent = '# Source\n\nContent to move.\n';

      mockSend
        // GetFile: check destination does not exist
        .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
        // GetFile: read source file
        .mockResolvedValueOnce({ fileContent: Buffer.from(sourceContent) })
        // GetBranch for commit
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        // CreateCommit (put dest + delete source)
        .mockResolvedValueOnce({ commitId: 'commit-6' });

      const plan = basePlan({
        action: 'move',
        file_path: '10_Work/old-path.md',
        destination_path: '20_Personal/new-path.md',
      });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(true);
      expect(result.commitId).toBe('commit-6');
    });

    it('rejects move when destination already exists', async () => {
      mockSend
        // GetFile: destination exists
        .mockResolvedValueOnce({ fileContent: Buffer.from('existing') });

      const plan = basePlan({
        action: 'move',
        file_path: '10_Work/source.md',
        destination_path: '20_Personal/dest.md',
      });
      const result = await executeFilingPlan(plan, baseConfig, baseFSI());

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('FSI update after successful commit', () => {
    it('calls FSI persist callback after successful create', async () => {
      mockSend
        .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        .mockResolvedValueOnce({ commitId: 'commit-fsi' });

      const persistFSI = vi.fn().mockResolvedValue(undefined);
      const plan = basePlan();
      const result = await executeFilingPlan(plan, baseConfig, baseFSI(), persistFSI);

      expect(result.success).toBe(true);
      expect(persistFSI).toHaveBeenCalledTimes(1);
      const updatedFSI = persistFSI.mock.calls[0][0];
      expect(updatedFSI.entries.some((e: any) => e.path === '10_Work/notes.md')).toBe(true);
    });
  });

  describe('FSI failure does not roll back commit', () => {
    it('commit succeeds even when FSI persist fails', async () => {
      mockSend
        .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
        .mockResolvedValueOnce({ branch: { commitId: 'parent-1' } })
        .mockResolvedValueOnce({ commitId: 'commit-fsi-fail' });

      const persistFSI = vi.fn().mockRejectedValue(new Error('FSI persist failed'));
      const plan = basePlan();
      const result = await executeFilingPlan(plan, baseConfig, baseFSI(), persistFSI);

      expect(result.success).toBe(true);
      expect(result.commitId).toBe('commit-fsi-fail');
      expect(result.warnings).toContain('Failed to persist Folder Structure Index update');
    });
  });
});
