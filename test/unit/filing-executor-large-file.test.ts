/**
 * Unit Tests: Filing Executor — Large file append behavior
 *
 * Tests that appending to a file exceeding 100KB logs a warning about
 * file size but still appends successfully (no hard rejection).
 *
 * Validates: Requirements 8.1
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function basePlan(overrides: Partial<FilingPlan> = {}): FilingPlan {
  return {
    intent: 'capture',
    intent_confidence: 0.95,
    file_path: '10_Work/large-file.md',
    action: 'append',
    title: 'Large File Append',
    content: 'New appended content.',
    reasoning: 'Appending to large file',
    integration_metadata: {
      related_files: [],
      content_disposition: 'continuation',
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
      { path: '10_Work/large-file.md', type: 'file', title: 'Large File' },
    ],
  };
}

const baseConfig = {
  repositoryName: 'test-repo',
  branchName: 'main',
  actorId: 'user-123',
};

/**
 * Generate a large markdown string exceeding the given size in bytes.
 */
function generateLargeContent(sizeBytes: number): string {
  const header = '---\ntitle: Large File\n---\n\n# Large File\n\n';
  const line = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor.\n';
  const linesNeeded = Math.ceil((sizeBytes - header.length) / line.length);
  return header + line.repeat(linesNeeded);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Filing Executor — large file append behavior', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('appending to a file that exceeds 100KB logs a warning about file size', async () => {
    const largeContent = generateLargeContent(110 * 1024); // ~110KB

    // Mock sequence:
    // 1. GetFile (read existing file for append) → large content
    // 2. GetBranch → commit ID
    // 3. CreateCommit → success
    mockSend
      .mockResolvedValueOnce({
        fileContent: Buffer.from(largeContent),
      })
      .mockResolvedValueOnce({
        branch: { commitId: 'parent-commit-1' },
      })
      .mockResolvedValueOnce({
        commitId: 'new-commit-1',
      });

    const plan = basePlan();
    const result = await executeFilingPlan(plan, baseConfig, baseFSI());

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('exceeds 100KB'),
      ])
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeds 100KB')
    );
  });

  it('content is still appended successfully despite large file size (no hard rejection)', async () => {
    const largeContent = generateLargeContent(120 * 1024); // ~120KB

    mockSend
      .mockResolvedValueOnce({
        fileContent: Buffer.from(largeContent),
      })
      .mockResolvedValueOnce({
        branch: { commitId: 'parent-commit-1' },
      })
      .mockResolvedValueOnce({
        commitId: 'new-commit-2',
      });

    const plan = basePlan();
    const result = await executeFilingPlan(plan, baseConfig, baseFSI());

    // Should succeed — no hard rejection
    expect(result.success).toBe(true);
    expect(result.commitId).toBe('new-commit-2');

    // Verify CreateCommit was called (the 3rd mock call)
    const createCommitCall = mockSend.mock.calls[2];
    expect(createCommitCall).toBeDefined();
    // The committed content should contain the appended text
    const committedContent = Buffer.from(
      createCommitCall[0].input.putFiles[0].fileContent
    ).toString('utf-8');
    expect(committedContent).toContain('New appended content.');
  });
});
