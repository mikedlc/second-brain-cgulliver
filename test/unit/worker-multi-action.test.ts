/**
 * Unit Tests: Worker — Multi-action message handling
 *
 * Tests that the worker correctly handles messages containing both a filing
 * item and a task, and that partial failures don't roll back successful items.
 *
 * Validates: Requirements 2.2, 2.3
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
const mockExecuteActionPlan = vi.hoisted(() => vi.fn());
const mockValidateMultiItemResponse = vi.hoisted(() => vi.fn());
const mockIsMultiItemResponse = vi.hoisted(() => vi.fn());
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
  isMultiItemResponse: mockIsMultiItemResponse,
  validateMultiItemResponse: mockValidateMultiItemResponse,
}));

vi.mock('../../src/components/action-executor', () => ({
  executeActionPlan: mockExecuteActionPlan,
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
    event_id: 'evt-multi-001',
    user_id: 'U_TEST',
    channel_id: 'C_TEST',
    message_text: messageText,
    message_ts: '1234567890.123456',
    thread_ts: undefined,
  });

  return {
    Records: [
      {
        messageId: 'msg-multi-001',
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

describe('Worker — Multi-action message handling', () => {
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
    mockIsMultiItemResponse.mockReturnValue(false);
  });

  it('message containing both a filing item and a task → primary action processed, task_details populated', async () => {
    // AgentCore returns a capture filing plan with task_details populated
    const filingPlanWithTask = {
      intent: 'capture',
      intent_confidence: 0.92,
      file_path: '25_Real_Estate/CNC_Mill_Build/supplier-contacts.md',
      action: 'create',
      title: 'Chase Bank Decision',
      content: '# Chase Bank Decision\n\nDecided to use Chase for the mortgage.',
      reasoning: 'User made a decision about banking and has a follow-up task',
      integration_metadata: {
        related_files: [],
        content_disposition: 'new_topic',
        confidence: 0.9,
      },
      task_details: {
        title: 'Call Chase Monday',
        context: 'Follow up on mortgage application',
        due_date: '2026-01-20',
      },
    };

    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: filingPlanWithTask,
    });
    mockValidateFilingPlan.mockReturnValue({ valid: true, errors: [] });
    mockExecuteFilingPlan.mockResolvedValue({
      success: true,
      commitId: 'commit-multi-1',
      warnings: [],
    });

    const event = buildSQSEvent('Decided to use Chase for the mortgage. Call them Monday.');
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);

    // Primary action (capture) was executed
    expect(mockExecuteFilingPlan).toHaveBeenCalled();
    const calledPlan = mockExecuteFilingPlan.mock.calls[0][0];
    expect(calledPlan.intent).toBe('capture');
    expect(calledPlan.title).toBe('Chase Bank Decision');

    // task_details is populated in the plan (available for downstream processing)
    expect(calledPlan.task_details).toEqual({
      title: 'Call Chase Monday',
      context: 'Follow up on mortgage application',
      due_date: '2026-01-20',
    });
  });

  it('partial failure on second item does not roll back first', async () => {
    // AgentCore returns a multi-item response
    const multiItemResponse = {
      items: [
        {
          intent: 'capture',
          intent_confidence: 0.95,
          classification: 'decision',
          confidence: 0.95,
          title: 'Use Chase Bank',
          content: 'Decided to use Chase.',
          reasoning: 'Banking decision',
          file_path: '20_Personal/banking.md',
          action: 'create',
          integration_metadata: {
            related_files: [],
            content_disposition: 'new_topic',
            confidence: 0.9,
          },
        },
        {
          intent: 'capture',
          intent_confidence: 0.9,
          classification: 'task',
          confidence: 0.9,
          title: 'Call Chase Monday',
          content: 'Call Chase about mortgage.',
          reasoning: 'Follow-up task',
          file_path: '10_Work/tasks.md',
          action: 'create',
          task_details: { title: 'Call Chase Monday', context: 'Mortgage follow-up' },
          integration_metadata: {
            related_files: [],
            content_disposition: 'new_topic',
            confidence: 0.85,
          },
        },
      ],
    };

    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: null,
      multiItemResponse,
    });
    mockIsMultiItemResponse.mockReturnValue(true);
    mockValidateMultiItemResponse.mockReturnValue({ valid: true, errors: [] });

    // First item succeeds, second item fails
    let callCount = 0;
    mockExecuteActionPlan.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          success: true,
          commitId: 'commit-item-1',
          filesModified: ['20_Personal/banking.md'],
          fileContents: ['Decided to use Chase.'],
        };
      }
      return {
        success: false,
        error: 'SES email delivery failed',
      };
    });

    const event = buildSQSEvent('Decided to use Chase for the mortgage. Call them Monday.');
    const result = await handler(event);

    // The handler should not fail entirely — at least one item succeeded
    expect(result.batchItemFailures).toHaveLength(0);

    // Confirmation was sent (consolidated)
    expect(mockSendSlackReply).toHaveBeenCalled();

    // First item was NOT rolled back — markCompleted was called (not markFailed)
    expect(mockMarkCompleted).toHaveBeenCalled();
  });
});
