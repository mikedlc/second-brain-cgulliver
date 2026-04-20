/**
 * Unit Tests: Filing Executor — Create-at-existing-path handling
 *
 * Tests that the filing executor correctly handles collisions when a
 * `create` action targets a path where a file already exists.
 *
 * Validates: Requirements 7.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist the mock function so it's available inside vi.mock factory ─────────

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
    constructor(opts?: any) {
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
    file_path: '10_Work/project-notes.md',
    action: 'create',
    title: 'Project Notes',
    content: '# Project Notes\n\nSome content here.',
    reasoning: 'New project notes',
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
    entries: [
      { path: '10_Work', type: 'folder' },
    ],
  };
}

const baseConfig = {
  repositoryName: 'test-repo',
  branchName: 'main',
  actorId: 'user-123',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Filing Executor — create-at-existing-path handling', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('create action where file already exists falls back to append and logs warning', async () => {
    const existingContent =
      '---\ntitle: Existing\n---\n\n# Existing\n\nOld content.\n';

    // Mock sequence:
    // 1. GetFile (check if file exists for create) → returns existing content
    // 2. GetFile (read for append) → returns existing content
    // 3. GetBranch (get parent commit for commit) → returns commit ID
    // 4. CreateCommit → success
    mockSend
      // First GetFile: file exists check in executeCreate
      .mockResolvedValueOnce({
        fileContent: Buffer.from(existingContent),
      })
      // Second GetFile: read file in executeAppend
      .mockResolvedValueOnce({
        fileContent: Buffer.from(existingContent),
      })
      // GetBranch for commit
      .mockResolvedValueOnce({
        branch: { commitId: 'parent-commit-1' },
      })
      // CreateCommit
      .mockResolvedValueOnce({
        commitId: 'new-commit-1',
      });

    const plan = basePlan({ action: 'create' });
    const result = await executeFilingPlan(plan, baseConfig, baseFSI());

    expect(result.success).toBe(true);
    expect(result.commitId).toBe('new-commit-1');
    expect(result.warnings).toContain(
      'File already exists at 10_Work/project-notes.md, fell back to append'
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to append')
    );
  });

  it('create action where file does not exist creates normally', async () => {
    // Mock sequence:
    // 1. GetFile (check if file exists) → FileDoesNotExistException
    // 2. GetBranch → commit ID
    // 3. CreateCommit → success
    mockSend
      // GetFile: file does not exist
      .mockRejectedValueOnce(new (FileDoesNotExistException as any)())
      // GetBranch for commit
      .mockResolvedValueOnce({
        branch: { commitId: 'parent-commit-1' },
      })
      // CreateCommit
      .mockResolvedValueOnce({
        commitId: 'new-commit-2',
      });

    const plan = basePlan({ action: 'create' });
    const result = await executeFilingPlan(plan, baseConfig, baseFSI());

    expect(result.success).toBe(true);
    expect(result.commitId).toBe('new-commit-2');
    // No fallback warning
    const fallbackWarnings = result.warnings.filter((w) =>
      w.includes('fell back to append')
    );
    expect(fallbackWarnings).toHaveLength(0);
  });
});
