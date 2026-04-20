/**
 * Unit Tests: Worker — Concurrent session and capture handling
 *
 * Tests that the worker correctly handles the interaction between active
 * discuss sessions and incoming capture messages.
 *
 * Validates: Requirements 13.1, 13.2, 13.10
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
const mockSetContext = vi.hoisted(() => vi.fn());
const mockDeleteContext = vi.hoisted(() => vi.fn());
const mockGetActiveSession = vi.hoisted(() => vi.fn());
const mockCreateSession = vi.hoisted(() => vi.fn());
const mockAppendMessage = vi.hoisted(() => vi.fn());
const mockMarkSessionFiled = vi.hoisted(() => vi.fn());
const mockPersistDraft = vi.hoisted(() => vi.fn());
const mockExecuteFilingPlan = vi.hoisted(() => vi.fn());
const mockRetrieveFSI = vi.hoisted(() => vi.fn());
const mockPersistFSI = vi.hoisted(() => vi.fn());
const mockValidateFilingPlan = vi.hoisted(() => vi.fn());
const mockParseFilingPlanFromLLM = vi.hoisted(() => vi.fn());

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
  parseFilingPlanFromLLM: mockParseFilingPlanFromLLM,
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
  createSession: mockCreateSession,
  appendMessage: mockAppendMessage,
  markSessionFiled: mockMarkSessionFiled,
  markSessionDiscarded: vi.fn(),
  buildSessionId: (ch: string, u: string) => `${ch}#${u}`,
  generateDiscussionId: () => 'ds-test123',
}));

vi.mock('../../src/components/draft-persistence', () => ({
  persistDraft: mockPersistDraft,
  loadDraft: vi.fn(),
  deleteDraft: vi.fn(),
  listDrafts: vi.fn().mockResolvedValue([]),
  buildDraftPath: vi.fn().mockReturnValue('00_System/Pending/test-draft.md'),
}));

vi.mock('../../src/components/receipt-logger', () => ({
  createReceipt: vi.fn().mockReturnValue({}),
  appendReceipt: mockAppendReceipt,
}));

vi.mock('../../src/components/conversation-context', () => ({
  getContext: mockGetContext,
  setContext: mockSetContext,
  deleteContext: mockDeleteContext,
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
  processQuery: vi.fn(),
  buildQueryPrompt: vi.fn(),
  generateNoResultsResponse: vi.fn(),
  formatQuerySlackReply: vi.fn(),
  validateResponseCitations: vi.fn(),
  queryProjectsByStatus: vi.fn(),
  formatProjectQueryForSlack: vi.fn(),
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

function buildSQSEvent(messageText: string, overrides: Record<string, string> = {}): SQSEvent {
  const body = JSON.stringify({
    event_id: overrides.event_id || 'evt-test-001',
    user_id: overrides.user_id || 'U_TEST',
    channel_id: overrides.channel_id || 'C_TEST',
    message_text: messageText,
    message_ts: '1234567890.123456',
    thread_ts: undefined,
  });

  return {
    Records: [
      {
        messageId: 'msg-001',
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

function makeCaptureFilingPlan(overrides: Record<string, any> = {}) {
  return {
    intent: 'capture',
    intent_confidence: 0.95,
    file_path: '10_Work/meeting-notes.md',
    action: 'create',
    title: 'Meeting Notes',
    content: '# Meeting Notes\n\nDiscussed project timeline.',
    reasoning: 'New meeting notes for work',
    integration_metadata: {
      related_files: [],
      content_disposition: 'new_topic',
      confidence: 0.9,
    },
    ...overrides,
  };
}

function makeDiscussFilingPlan(overrides: Record<string, any> = {}) {
  return {
    intent: 'discuss',
    intent_confidence: 0.9,
    file_path: '',
    action: 'create',
    title: 'Solar project discussion',
    content: '',
    reasoning: 'User wants to discuss solar options',
    integration_metadata: {
      related_files: [],
      content_disposition: 'new_topic',
      confidence: 0.8,
    },
    discuss_response: 'Let me help you think through the solar options.',
    ...overrides,
  };
}

function makeActiveSession() {
  return {
    session_id: 'C_TEST#U_TEST',
    discussion_id: 'ds-abc1234',
    topic: 'Solar project options',
    related_area: '25_Real_Estate',
    messages: [
      { role: 'user' as const, content: 'What are the solar options?', timestamp: '2026-01-01T10:00:00Z' },
      { role: 'assistant' as const, content: 'There are several options...', timestamp: '2026-01-01T10:00:01Z' },
    ],
    status: 'active' as const,
    created_at: '2026-01-01T10:00:00Z',
    last_active_at: '2026-01-01T10:00:01Z',
    message_count: 2,
    expires_at: Math.floor(Date.now() / 1000) + 14400,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Worker — Concurrent session and capture handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryAcquireLock.mockResolvedValue(true);
    mockUpdateExecutionState.mockResolvedValue(undefined);
    mockMarkCompleted.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockGetContext.mockResolvedValue(null);
    mockSendSlackReply.mockResolvedValue(undefined);
    mockAppendReceipt.mockResolvedValue(undefined);
    mockLoadSystemPrompt.mockResolvedValue({
      content: 'System prompt content',
      metadata: { commitId: 'abc123', sha256: 'hash123' },
    });
    mockRetrieveFSI.mockResolvedValue(null);
    mockPersistFSI.mockResolvedValue(undefined);
    mockPersistDraft.mockResolvedValue(undefined);
    mockAppendMessage.mockResolvedValue(undefined);
  });

  it('user has active discuss session, sends unrelated capture message → capture bypasses session', async () => {
    // Active session exists
    mockGetActiveSession.mockResolvedValue(makeActiveSession());

    // AgentCore returns a capture intent (unrelated to session topic)
    const capturePlan = makeCaptureFilingPlan({
      title: 'Grocery list',
      file_path: '20_Personal/grocery-list.md',
    });
    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: capturePlan,
    });
    mockValidateFilingPlan.mockReturnValue({ valid: true, errors: [] });
    mockExecuteFilingPlan.mockResolvedValue({
      success: true,
      commitId: 'commit-123',
      warnings: [],
    });

    const event = buildSQSEvent('Pick up milk and eggs');
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);

    // Capture was executed (filing executor called), not discuss mode
    expect(mockExecuteFilingPlan).toHaveBeenCalled();

    // Session was NOT modified (no appendMessage for the capture message)
    // The capture flow doesn't interact with the session store
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('user has active discuss session, sends message related to session topic → added to session', async () => {
    // Active session exists
    mockGetActiveSession.mockResolvedValue(makeActiveSession());

    // AgentCore returns a discuss intent (related to session topic)
    const discussPlan = makeDiscussFilingPlan({
      title: 'Solar project options',
      discuss_response: 'Based on your workshop dimensions, I recommend...',
    });
    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: discussPlan,
    });
    mockValidateFilingPlan.mockReturnValue({ valid: true, errors: [] });

    const event = buildSQSEvent('What about the cost of solar panels?');
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);

    // Message was appended to session (user message + assistant response)
    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      'C_TEST#U_TEST',
      'user',
      'What about the cost of solar panels?'
    );

    // Draft was persisted
    expect(mockPersistDraft).toHaveBeenCalled();

    // Conversational reply was sent
    expect(mockSendSlackReply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        text: 'Based on your workshop dimensions, I recommend...',
      })
    );
  });

  it('user sends capture message with no active session → normal capture flow', async () => {
    // No active session
    mockGetActiveSession.mockResolvedValue(null);

    // AgentCore returns a capture intent
    const capturePlan = makeCaptureFilingPlan();
    mockInvokeAgentRuntime.mockResolvedValue({
      success: true,
      actionPlan: capturePlan,
    });
    mockValidateFilingPlan.mockReturnValue({ valid: true, errors: [] });
    mockExecuteFilingPlan.mockResolvedValue({
      success: true,
      commitId: 'commit-456',
      warnings: [],
    });

    const event = buildSQSEvent('Had a great meeting about the project timeline');
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);

    // Filing executor was called for capture
    expect(mockExecuteFilingPlan).toHaveBeenCalled();

    // No session operations
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockPersistDraft).not.toHaveBeenCalled();

    // Confirmation sent
    expect(mockSendSlackReply).toHaveBeenCalled();
  });
});
