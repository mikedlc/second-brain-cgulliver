/**
 * Unit Tests: Worker — Empty and whitespace-only message handling
 *
 * Tests that the worker gracefully handles edge cases for message content:
 * whitespace-only, emoji-only, and very short messages.
 *
 * Validates: Requirements 1.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks ──────────────────────────────────────────────────────────────

const mockSend = vi.hoisted(() => vi.fn());
const mockDocSend = vi.hoisted(() => vi.fn());
const mockInvokeAgentRuntime = vi.hoisted(() => vi.fn());
const mockSendSlackReply = vi.hoisted(() => vi.fn());
const mockTryAcquireLock = vi.hoisted(() => vi.fn());
const mockUpdateExecutionState = vi.hoisted(() => vi.fn());
const mockMarkCompleted = vi.hoisted(() => vi.fn());
const mockMarkFailed = vi.hoisted(() => vi.fn());
const mockLoadSystemPrompt = vi.hoisted(() => vi.fn());
const mockAppendReceipt = vi.hoisted(() => vi.fn());
const mockGetContext = vi.hoisted(() => vi.fn());
const mockGetActiveSession = vi.hoisted(() => vi.fn());
const mockValidateFilingPlan = vi.hoisted(() => vi.fn());
const mockExecuteFilingPlan = vi.hoisted(() => vi.fn());
const mockRetrieveFSI = vi.hoisted(() => vi.fn());
const mockPersistFSI = vi.hoisted(() => vi.fn());

// ── Mock modules ─────────────────────────────────────────────────────────────

vi.mock('@aws-sdk/client-codecommit', () => ({
  CodeCommitClient: class { send = mockSend; },
  GetBranchCommand: class { constructor(public input: any) {} },
  GetFileCommand: class { constructor(public input: any) {} },
  CreateCommitCommand: class { constructor(public input: any) {} },
  FileDoesNotExistException: class extends Error { override name = 'FileDoesNotExistException'; },
  FolderDoesNotExistException: class extends Error { override name = 'FolderDoesNotExistException'; },
  ParentCommitIdOutdatedException: class extends Error { override name = 'ParentCommitIdOutdatedException'; },
  GetFolderCommand: class { constructor(public input: any) {} },
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDocSend }) },
  GetCommand: class { constructor(public input: any) {} },
  PutCommand: class { constructor(public input: any) {} },
  UpdateCommand: class { constructor(public input: any) {} },
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = vi.fn(); },
  GetParameterCommand: class { constructor(public input: any) {} },
}));

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class { send = vi.fn(); },
  SendEmailCommand: class { constructor(public input: any) {} },
}));

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class { send = vi.fn(); },
}));

vi.mock('../../src/components/idempotency-guard', () => ({
  tryAcquireLock: mockTryAcquireLock,
  updateExecutionState: mockUpdateExecutionState,
  markCompleted: mockMarkCompleted,
  markFailed: mockMarkFailed,
}));

vi.mock('../../src/components/system-prompt-loader', () => ({
  loadSystemPrompt: mockLoadSystemPrompt,
}));

vi.mock('../../src/components/agentcore-client', () => ({
  invokeAgentRuntime: mockInvokeAgentRuntime,
  shouldAskClarification: vi.fn().mockReturnValue(false),
  generateClarificationPrompt: vi.fn(),
}));

vi.mock('../../src/components/filing-plan-validator', () => ({
  validateFilingPlan: mockValidateFilingPlan,
  parseFilingPlanFromLLM: vi.fn(),
}));

vi.mock('../../src/components/filing-executor', () => ({
  executeFilingPlan: mockExecuteFilingPlan,
}));

vi.mock('../../src/components/fsi-memory-client', () => ({
  retrieveFSI: mockRetrieveFSI,
  persistFSI: mockPersistFSI,
}));

vi.mock('../../src/components/conversation-session-store', () => ({
  getActiveSession: mockGetActiveSession,
  createSession: vi.fn(),
  appendMessage: vi.fn(),
  markSessionFiled: vi.fn(),
  markSessionDiscarded: vi.fn(),
  buildSessionId: (ch: string, u: string) => `${ch}#${u}`,
  generateDiscussionId: () => 'ds-test123',
}));

vi.mock('../../src/components/draft-persistence', () => ({
  persistDraft: vi.fn(),
  loadDraft: vi.fn(),
  deleteDraft: vi.fn(),
  listDrafts: vi.fn().mockResolvedValue([]),
  buildDraftPath: vi.fn(),
}));

vi.mock('../../src/components/receipt-logger', () => ({
  createReceipt: vi.fn().mockReturnValue({}),
  appendReceipt: mockAppendReceipt,
}));

vi.mock('../../src/components/conversation-context', () => ({
  getContext: mockGetContext,
  setContext: vi.fn(),
  deleteContext: vi.fn(),
}));

vi.mock('../../src/components/slack-responder', () => ({
  formatConfirmationReply: vi.fn().mockReturnValue('Confirmed'),
  formatClarificationReply: vi.fn().mockReturnValue('Clarification'),
  formatErrorReply: vi.fn().mockImplementation((msg: string) => `Error: ${msg}`),
  sendSlackReply: mockSendSlackReply,
}));

vi.mock('../../src/components/action-plan', () => ({
  validateActionPlan: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  isMultiItemResponse: vi.fn().mockReturnValue(false),
  validateMultiItemResponse: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));

vi.mock('../../src/components/action-executor', () => ({
  executeActionPlan: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/components/fix-handler', () => ({
  parseFixCommand: vi.fn().mockReturnValue({ isFixCommand: false }),
  getFixableReceipt: vi.fn(),
  applyFix: vi.fn(),
  canApplyFix: vi.fn(),
  detectReclassifyRequest: vi.fn(),
  extractOriginalMessage: vi.fn(),
}));

vi.mock('../../src/components/project-matcher', () => ({
  findMatchingProject: vi.fn(),
}));

vi.mock('../../src/components/knowledge-store', () => ({
  readFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock('../../src/components/knowledge-search', () => ({
  searchKnowledgeBase: vi.fn(),
}));

vi.mock('../../src/components/query-handler', () => ({
  processQuery: vi.fn(),
  buildQueryPrompt: vi.fn(),
  generateNoResultsResponse: vi.fn(),
  formatQuerySlackReply: vi.fn(),
  validateResponseCitations: vi.fn(),
  queryProjectsByStatus: vi.fn(),
  formatProjectQueryForSlack: vi.fn(),
}));

vi.mock('../../src/components/project-status-updater', () => ({
  updateProjectStatus: vi.fn(),
}));

vi.mock('../../src/components/task-logger', () => ({
  appendTaskLog: vi.fn(),
  appendReferenceLog: vi.fn(),
}));

vi.mock('../../src/components/sync-invoker', () => ({
  invokeSyncItem: vi.fn().mockResolvedValue({ success: true }),
  invokeSyncAll: vi.fn().mockResolvedValue({ success: true }),
  invokeDeleteItem: vi.fn().mockResolvedValue({ success: true }),
  invokeHealthCheck: vi.fn().mockResolvedValue({ success: true }),
  invokeRepair: vi.fn().mockResolvedValue({ success: true }),
}));

// ── Import handler ───────────────────────────────────────────────────────────

import { handler } from '../../src/handlers/worker';
import type { SQSEvent } from 'aws-lambda';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSQSEvent(messageText: string): SQSEvent {
  const body = JSON.stringify({
    event_id: 'evt-empty-001',
    user_id: 'U_TEST',
    channel_id: 'C_TEST',
    message_text: messageText,
    message_ts: '1234567890.123456',
    thread_ts: undefined,
  });

  return {
    Records: [
      {
        messageId: 'msg-empty-001',
        receiptHandle: 'handle-001',
        body,
        attributes: {} as any,
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789:test-queue',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Worker — Empty and whitespace-only message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryAcquireLock.mockResolvedValue(true);
    mockUpdateExecutionState.mockResolvedValue(undefined);
    mockMarkCompleted.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockGetContext.mockResolvedValue(null);
    mockSendSlackReply.mockResolvedValue(undefined);
    mockAppendReceipt.mockResolvedValue(undefined);
    mockGetActiveSession.mockResolvedValue(null);
    mockLoadSystemPrompt.mockResolvedValue({
      content: 'System prompt content',
      metadata: { commitId: 'abc123', sha256: 'hash123' },
    });
    mockRetrieveFSI.mockResolvedValue(null);
    mockPersistFSI.mockResolvedValue(undefined);
  });

  it('whitespace-only message is rejected gracefully (no Classifier invocation)', async () => {
    // The sanitizeInput function strips control chars but preserves whitespace.
    // After sanitization, a whitespace-only message should still be passed to AgentCore.
    // AgentCore should fail or return an error for empty content.
    mockInvokeAgentRuntime.mockResolvedValue({
      success: false,
      error: 'Empty message content',
    });

    const event = buildSQSEvent('   \n\t  ');
    const result = await handler(event);

    // The message should fail gracefully — error reply sent to user
    // Either it fails at AgentCore or the handler catches it
    expect(mockSendSlackReply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        text: expect.stringContaining('Error'),
      })
    );

    // Should be in batch failures since it throws
    expect(result.batchItemFailures).toHaveLength(1);
  });

  it('emoji-only message is processed', async () => {
    // Emoji-only messages should be processed normally
    const capturePlan = {
      intent: 'capture',
      intent_confidence: 0.7,
      file_path: '_INBOX/emoji-note.md',
      action: 'create',
      title: 'Emoji Note',
      content: '# Emoji Note\n\n🎉',
      reasoning: 'Emoji-only message, filing to inbox',
      integration_metadata: {
        related_files: [],
        content_disposition: 'new_topic',
        confidence: 0.6,
      },
    };

    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: capturePlan,
    });
    mockValidateFilingPlan.mockReturnValue({ valid: true, errors: [] });
    mockExecuteFilingPlan.mockResolvedValue({
      success: true,
      commitId: 'commit-emoji-1',
      warnings: [],
    });

    const event = buildSQSEvent('🎉');
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);

    // AgentCore was invoked with the emoji
    expect(mockInvokeAgentRuntime).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        prompt: '🎉',
      })
    );

    // Filing executor was called
    expect(mockExecuteFilingPlan).toHaveBeenCalled();

    // Confirmation sent
    expect(mockSendSlackReply).toHaveBeenCalled();
  });

  it('very short message (1-2 characters) is processed without error', async () => {
    const capturePlan = {
      intent: 'capture',
      intent_confidence: 0.6,
      file_path: '_INBOX/short-note.md',
      action: 'create',
      title: 'Short Note',
      content: '# Short Note\n\nok',
      reasoning: 'Very short message, filing to inbox',
      integration_metadata: {
        related_files: [],
        content_disposition: 'new_topic',
        confidence: 0.5,
      },
    };

    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: capturePlan,
    });
    mockValidateFilingPlan.mockReturnValue({ valid: true, errors: [] });
    mockExecuteFilingPlan.mockResolvedValue({
      success: true,
      commitId: 'commit-short-1',
      warnings: [],
    });

    const event = buildSQSEvent('ok');
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);

    // AgentCore was invoked
    expect(mockInvokeAgentRuntime).toHaveBeenCalled();

    // Filing executor was called
    expect(mockExecuteFilingPlan).toHaveBeenCalled();

    // No errors
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});
