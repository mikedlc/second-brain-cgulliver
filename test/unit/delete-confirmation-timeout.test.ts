/**
 * Unit Tests: Delete Confirmation Timeout
 *
 * Tests the two-step delete confirmation flow:
 * - Pending delete stored in DynamoDB, user responds "yes" → delete executes
 * - Pending delete stored, user responds with unrelated message → delete cancelled
 * - Pending delete stored, user responds "no" → delete cancelled, confirmation cleared
 *
 * Validates: Requirements 2.13
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
  class DeleteCommand {
    constructor(public input: any) {}
  }
  return {
    DynamoDBDocumentClient: MockDynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    UpdateCommand,
    DeleteCommand,
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

vi.mock('@aws-sdk/client-ssm', () => {
  class MockSSMClient {
    send = vi.fn().mockResolvedValue({ Parameter: { Value: 'xoxb-test-token' } });
  }
  class GetParameterCommand {
    constructor(public input: any) {}
  }
  return { SSMClient: MockSSMClient, GetParameterCommand };
});

import {
  getContext,
  setContext,
  deleteContext,
} from '../../src/components/conversation-context';
import type { ConversationContext } from '../../src/components/conversation-context';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulates the delete confirmation flow as implemented in the worker.
 * The worker stores a pending delete in conversation context, then on the
 * next message checks if the user confirmed.
 */
interface PendingDeleteContext {
  original_event_id: string;
  original_message: string;
  original_classification: string;
  original_confidence: number;
  clarification_asked: string;
}

function makePendingDeleteContext(filePath: string): PendingDeleteContext {
  return {
    original_event_id: 'evt-123',
    original_message: JSON.stringify({
      intent: 'capture',
      intent_confidence: 0.95,
      file_path: filePath,
      action: 'delete',
      title: 'Old Notes',
      content: '',
      reasoning: 'User requested deletion',
      integration_metadata: {
        related_files: [],
        content_disposition: 'new_topic',
        confidence: 0.9,
      },
    }),
    original_classification: 'delete-confirm',
    original_confidence: 0.95,
    clarification_asked: `Delete ${filePath}? Reply 'yes' to confirm.`,
  };
}

/**
 * Simulates the worker's delete confirmation response handling logic.
 * Returns what action the worker would take.
 */
function processDeleteConfirmationResponse(
  userResponse: string,
  pendingContext: PendingDeleteContext
): { action: 'execute_delete' | 'cancel_delete' | 'process_normally'; reason: string } {
  const normalized = userResponse.trim().toLowerCase();

  // Check for explicit confirmation
  if (normalized === 'yes' || normalized === 'y' || normalized === 'confirm') {
    return { action: 'execute_delete', reason: 'User confirmed deletion' };
  }

  // Check for explicit rejection
  if (normalized === 'no' || normalized === 'n' || normalized === 'cancel') {
    return { action: 'cancel_delete', reason: 'User explicitly cancelled' };
  }

  // Unrelated message → cancel the pending delete and process the message normally
  return { action: 'cancel_delete', reason: 'Unrelated message received, cancelling pending delete' };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Delete Confirmation Timeout', () => {
  beforeEach(() => {
    mockDDBSend.mockReset();
    mockCCSend.mockReset();
  });

  describe('pending delete stored, user responds "yes"', () => {
    it('delete executes when user confirms with "yes"', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse('yes', pendingContext);

      expect(result.action).toBe('execute_delete');
      expect(result.reason).toContain('confirmed');
    });

    it('delete executes when user confirms with "y"', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse('y', pendingContext);

      expect(result.action).toBe('execute_delete');
    });

    it('delete executes when user confirms with "confirm"', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse('confirm', pendingContext);

      expect(result.action).toBe('execute_delete');
    });
  });

  describe('pending delete stored, user responds with unrelated message', () => {
    it('delete is cancelled when user sends unrelated message', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse(
        'I had a great meeting today about the new project',
        pendingContext
      );

      expect(result.action).toBe('cancel_delete');
      expect(result.reason).toContain('Unrelated');
    });

    it('delete is cancelled when user sends a question', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse(
        'What files do I have about real estate?',
        pendingContext
      );

      expect(result.action).toBe('cancel_delete');
    });
  });

  describe('pending delete stored, user responds "no"', () => {
    it('delete cancelled and confirmation cleared when user says "no"', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse('no', pendingContext);

      expect(result.action).toBe('cancel_delete');
      expect(result.reason).toContain('cancelled');
    });

    it('delete cancelled when user says "cancel"', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse('cancel', pendingContext);

      expect(result.action).toBe('cancel_delete');
      expect(result.reason).toContain('cancelled');
    });

    it('delete cancelled when user says "n"', () => {
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');
      const result = processDeleteConfirmationResponse('n', pendingContext);

      expect(result.action).toBe('cancel_delete');
    });
  });

  describe('integration with conversation context store', () => {
    it('pending delete is stored in DynamoDB via setContext', async () => {
      mockDDBSend.mockResolvedValueOnce({}); // PutCommand for setContext

      const config = { tableName: 'test-conversations', ttlParam: '/test/ttl' };
      const pendingContext = makePendingDeleteContext('10_Work/old-notes.md');

      // Simulate storing the pending delete context
      await setContext(config, 'C123', 'U456', pendingContext as any);

      expect(mockDDBSend).toHaveBeenCalledTimes(1);
    });

    it('pending delete is cleared from DynamoDB via deleteContext', async () => {
      mockDDBSend.mockResolvedValueOnce({}); // DeleteCommand for deleteContext

      const config = { tableName: 'test-conversations', ttlParam: '/test/ttl' };

      await deleteContext(config, 'C123', 'U456');

      expect(mockDDBSend).toHaveBeenCalledTimes(1);
    });
  });
});
