/**
 * Unit Tests: Conversation Handler
 *
 * Tests session creation, message accumulation, draft persistence,
 * resume from draft, discard, and list drafts formatting.
 *
 * Validates: Requirements 13.5, 13.14, 13.15, 13.16, 13.17
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks ──────────────────────────────────────────────────────────────

const mockDDBSend = vi.hoisted(() => vi.fn());
const mockCCSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dynamodb', () => {
  class MockDynamoDBClient {
    send = mockDDBSend;
  }
  return { DynamoDBClient: MockDynamoDBClient };
});

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class MockDynamoDBDocumentClient {
    static from = () => new MockDynamoDBDocumentClient();
    send = mockDDBSend;
  }
  class GetCommand {
    constructor(public input: any) {}
  }
  class PutCommand {
    constructor(public input: any) {}
  }
  class UpdateCommand {
    constructor(public input: any) {}
  }
  return {
    DynamoDBDocumentClient: MockDynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    UpdateCommand,
  };
});

vi.mock('@aws-sdk/client-codecommit', () => {
  class MockCodeCommitClient {
    send = mockCCSend;
  }
  class GetBranchCommand {
    constructor(public input: any) {}
  }
  class GetFileCommand {
    constructor(public input: any) {}
  }
  class GetFolderCommand {
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
  class FolderDoesNotExistException extends Error {
    override name = 'FolderDoesNotExistException';
    constructor() {
      super('Folder does not exist');
    }
  }
  return {
    CodeCommitClient: MockCodeCommitClient,
    GetBranchCommand,
    GetFileCommand,
    GetFolderCommand,
    CreateCommitCommand,
    FileDoesNotExistException,
    FolderDoesNotExistException,
  };
});

import {
  createSession,
  appendMessage,
  getActiveSession,
  markSessionFiled,
  markSessionDiscarded,
  buildSessionId,
} from '../../src/components/conversation-session-store';
import {
  persistDraft,
  loadDraft,
  deleteDraft,
  listDrafts,
  buildDraftPath,
  buildDraftContent,
} from '../../src/components/draft-persistence';
import type { ConversationSession } from '../../src/types/conversation-session';

// ── Helpers ──────────────────────────────────────────────────────────────────

const sessionConfig = { tableName: 'test-sessions' };
const knowledgeConfig = { repositoryName: 'test-repo', branchName: 'main' };

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    session_id: 'C123#U456',
    discussion_id: 'ds-abc1234',
    topic: 'CNC Mill Build',
    related_area: '25_Real_Estate',
    messages: [
      { role: 'user', content: 'Thinking about CNC mill options', timestamp: '2026-01-15T10:00:00Z' },
      { role: 'assistant', content: 'What size are you considering?', timestamp: '2026-01-15T10:00:05Z' },
    ],
    status: 'active',
    created_at: '2026-01-15T10:00:00Z',
    last_active_at: '2026-01-15T10:00:05Z',
    message_count: 2,
    expires_at: Math.floor(Date.now() / 1000) + 14400,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Conversation Session Store', () => {
  beforeEach(() => {
    mockDDBSend.mockReset();
  });

  describe('createSession', () => {
    it('creates a new session with correct fields', async () => {
      mockDDBSend.mockResolvedValueOnce({}); // PutCommand

      const session = await createSession(sessionConfig, 'C123', 'U456', 'CNC Mill', '25_Real_Estate');

      expect(session.session_id).toBe('C123#U456');
      expect(session.topic).toBe('CNC Mill');
      expect(session.related_area).toBe('25_Real_Estate');
      expect(session.status).toBe('active');
      expect(session.messages).toHaveLength(0);
      expect(session.message_count).toBe(0);
      expect(session.discussion_id).toMatch(/^ds-[a-f0-9]{7}$/);
      expect(session.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('appendMessage', () => {
    it('appends a message and extends TTL', async () => {
      mockDDBSend.mockResolvedValueOnce({}); // UpdateCommand

      await appendMessage(sessionConfig, 'C123#U456', 'user', 'Hello');

      expect(mockDDBSend).toHaveBeenCalledTimes(1);
      const cmd = mockDDBSend.mock.calls[0][0];
      expect(cmd.input.Key).toEqual({ session_id: 'C123#U456' });
      expect(cmd.input.ExpressionAttributeValues[':one']).toBe(1);
    });
  });

  describe('getActiveSession', () => {
    it('returns active session when found', async () => {
      const session = makeSession();
      mockDDBSend.mockResolvedValueOnce({ Item: session });

      const result = await getActiveSession(sessionConfig, 'C123', 'U456');

      expect(result).not.toBeNull();
      expect(result!.session_id).toBe('C123#U456');
      expect(result!.status).toBe('active');
    });

    it('returns null when no session exists', async () => {
      mockDDBSend.mockResolvedValueOnce({ Item: undefined });

      const result = await getActiveSession(sessionConfig, 'C123', 'U456');

      expect(result).toBeNull();
    });

    it('returns null when session is expired', async () => {
      const session = makeSession({ expires_at: Math.floor(Date.now() / 1000) - 100 });
      mockDDBSend.mockResolvedValueOnce({ Item: session });

      const result = await getActiveSession(sessionConfig, 'C123', 'U456');

      expect(result).toBeNull();
    });
  });

  describe('markSessionFiled', () => {
    it('updates session status to filed', async () => {
      mockDDBSend.mockResolvedValueOnce({}); // UpdateCommand

      await markSessionFiled(sessionConfig, 'C123#U456');

      expect(mockDDBSend).toHaveBeenCalledTimes(1);
      const cmd = mockDDBSend.mock.calls[0][0];
      expect(cmd.input.ExpressionAttributeValues[':status']).toBe('filed');
    });
  });

  describe('markSessionDiscarded', () => {
    it('updates session status to discarded', async () => {
      mockDDBSend.mockResolvedValueOnce({}); // UpdateCommand

      await markSessionDiscarded(sessionConfig, 'C123#U456');

      expect(mockDDBSend).toHaveBeenCalledTimes(1);
      const cmd = mockDDBSend.mock.calls[0][0];
      expect(cmd.input.ExpressionAttributeValues[':status']).toBe('discarded');
    });
  });
});

describe('Draft Persistence', () => {
  beforeEach(() => {
    mockCCSend.mockReset();
  });

  describe('persistDraft', () => {
    it('writes draft to CodeCommit on each message', async () => {
      const session = makeSession();

      // GetBranch → parent commit
      mockCCSend.mockResolvedValueOnce({ branch: { commitId: 'parent-1' } });
      // CreateCommit → success
      mockCCSend.mockResolvedValueOnce({ commitId: 'draft-commit-1' });

      await persistDraft(session, knowledgeConfig);

      expect(mockCCSend).toHaveBeenCalledTimes(2);
      const commitCmd = mockCCSend.mock.calls[1][0];
      expect(commitCmd.input.putFiles[0].filePath).toContain('00_System/Pending/');
      expect(commitCmd.input.putFiles[0].filePath).toContain('ds-abc1234');
    });
  });

  describe('loadDraft (resume from draft)', () => {
    it('loads and parses a draft file into a session', async () => {
      const session = makeSession();
      const draftContent = buildDraftContent(session);
      const draftPath = buildDraftPath(session);

      // GetFile → returns draft content
      mockCCSend.mockResolvedValueOnce({
        fileContent: Buffer.from(draftContent),
      });

      const restored = await loadDraft(draftPath, knowledgeConfig);

      expect(restored).not.toBeNull();
      expect(restored!.discussion_id).toBe('ds-abc1234');
      expect(restored!.topic).toBe('CNC Mill Build');
      expect(restored!.related_area).toBe('25_Real_Estate');
      expect(restored!.messages).toHaveLength(2);
      expect(restored!.messages[0].role).toBe('user');
      expect(restored!.messages[1].role).toBe('assistant');
    });

    it('returns null for non-existent draft', async () => {
      const { FileDoesNotExistException: FDNE } = await import('@aws-sdk/client-codecommit');
      mockCCSend.mockRejectedValueOnce(new (FDNE as any)());

      const result = await loadDraft('00_System/Pending/nonexistent.md', knowledgeConfig);

      expect(result).toBeNull();
    });
  });

  describe('deleteDraft (discard)', () => {
    it('deletes draft file from CodeCommit', async () => {
      // GetBranch → parent commit
      mockCCSend.mockResolvedValueOnce({ branch: { commitId: 'parent-1' } });
      // CreateCommit (delete) → success
      mockCCSend.mockResolvedValueOnce({ commitId: 'delete-commit-1' });

      await deleteDraft('00_System/Pending/2026-01-15__cnc-mill__ds-abc1234.md', knowledgeConfig);

      expect(mockCCSend).toHaveBeenCalledTimes(2);
      const commitCmd = mockCCSend.mock.calls[1][0];
      expect(commitCmd.input.deleteFiles[0].filePath).toContain('ds-abc1234');
    });
  });

  describe('listDrafts', () => {
    it('returns formatted list of pending drafts', async () => {
      const draftContent = [
        '---',
        'session_id: ds-abc1234',
        'topic: CNC Mill Build',
        'related_area: 25_Real_Estate',
        'status: open',
        'created_at: 2026-01-15T10:00:00Z',
        'last_active_at: 2026-01-15T10:05:00Z',
        'message_count: 4',
        '---',
        '',
        '# Discussion: CNC Mill Build',
      ].join('\n');

      // GetFolder → returns file list
      mockCCSend.mockResolvedValueOnce({
        files: [
          { absolutePath: '00_System/Pending/2026-01-15__cnc-mill-build__ds-abc1234.md' },
        ],
      });
      // GetFile → returns draft content
      mockCCSend.mockResolvedValueOnce({
        fileContent: Buffer.from(draftContent),
      });

      const drafts = await listDrafts(knowledgeConfig);

      expect(drafts).toHaveLength(1);
      expect(drafts[0].session_id).toBe('ds-abc1234');
      expect(drafts[0].topic).toBe('CNC Mill Build');
      expect(drafts[0].message_count).toBe(4);
    });

    it('returns empty array when no pending folder exists', async () => {
      const { FolderDoesNotExistException: FDNE } = await import('@aws-sdk/client-codecommit');
      mockCCSend.mockRejectedValueOnce(new (FDNE as any)());

      const drafts = await listDrafts(knowledgeConfig);

      expect(drafts).toHaveLength(0);
    });
  });
});
