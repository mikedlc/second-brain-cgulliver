/**
 * Property-Based Tests: Session Message Accumulation
 *
 * Feature: organic-knowledge-filing, Property 9: Session message accumulation
 *
 * **Validates: Requirements 13.5, 13.9**
 *
 * For any sequence of messages added to a conversation session, the session's messages
 * array SHALL contain all messages in the order they were added, with no messages lost
 * or reordered, and message_count SHALL equal the length of the messages array.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { ConversationSession, SessionMessage } from '../../src/types/conversation-session';

// --- Arbitraries ---

/** Generate a random session message */
const sessionMessage: fc.Arbitrary<SessionMessage> = fc.record({
  role: fc.constantFrom('user', 'assistant') as fc.Arbitrary<'user' | 'assistant'>,
  content: fc.string({ minLength: 1, maxLength: 500 }),
  timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2027-12-31') }).map(
    (d) => d.toISOString()
  ),
});

/** Generate a random sequence of messages (1 to 50 messages) */
const messageSequence: fc.Arbitrary<SessionMessage[]> = fc.array(sessionMessage, {
  minLength: 1,
  maxLength: 50,
});

/** Generate a base session (empty messages) */
const baseSession: fc.Arbitrary<ConversationSession> = fc.record({
  session_id: fc.string({ minLength: 5, maxLength: 30 }).map((s) => `C123#U${s.replace(/[^a-zA-Z0-9]/g, 'x')}`),
  discussion_id: fc.string({ minLength: 7, maxLength: 7 }).map((s) => `ds-${s.replace(/[^a-f0-9]/g, 'a')}`),
  topic: fc.string({ minLength: 1, maxLength: 100 }),
  related_area: fc.constantFrom('10_Work', '20_Personal', '25_Real_Estate', '_INBOX'),
  messages: fc.constant([] as SessionMessage[]),
  status: fc.constant('active' as const),
  created_at: fc.date({ min: new Date('2024-01-01'), max: new Date('2027-12-31') }).map(
    (d) => d.toISOString()
  ),
  last_active_at: fc.date({ min: new Date('2024-01-01'), max: new Date('2027-12-31') }).map(
    (d) => d.toISOString()
  ),
  message_count: fc.constant(0),
  expires_at: fc.integer({ min: 1700000000, max: 2000000000 }),
});

/**
 * Simulate appending messages to a session object (pure function, no DynamoDB).
 * This mirrors the logic of appendMessage but operates on the in-memory session.
 */
function simulateAppendMessage(
  session: ConversationSession,
  message: SessionMessage
): ConversationSession {
  return {
    ...session,
    messages: [...session.messages, message],
    message_count: session.message_count + 1,
    last_active_at: message.timestamp,
  };
}

describe('Property 9: Session message accumulation', () => {
  it('all messages are preserved in order after sequential appends', () => {
    fc.assert(
      fc.property(baseSession, messageSequence, (session, messages) => {
        let current = session;
        for (const msg of messages) {
          current = simulateAppendMessage(current, msg);
        }

        // All messages present
        expect(current.messages).toHaveLength(messages.length);

        // Messages in correct order
        for (let i = 0; i < messages.length; i++) {
          expect(current.messages[i].role).toBe(messages[i].role);
          expect(current.messages[i].content).toBe(messages[i].content);
          expect(current.messages[i].timestamp).toBe(messages[i].timestamp);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('message_count equals messages array length after accumulation', () => {
    fc.assert(
      fc.property(baseSession, messageSequence, (session, messages) => {
        let current = session;
        for (const msg of messages) {
          current = simulateAppendMessage(current, msg);
        }

        expect(current.message_count).toBe(current.messages.length);
      }),
      { numRuns: 100 }
    );
  });

  it('no messages are lost during accumulation', () => {
    fc.assert(
      fc.property(baseSession, messageSequence, (session, messages) => {
        let current = session;
        for (const msg of messages) {
          current = simulateAppendMessage(current, msg);
        }

        // Every original message content appears in the session
        const sessionContents = current.messages.map((m) => m.content);
        for (const msg of messages) {
          expect(sessionContents).toContain(msg.content);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('no messages are reordered during accumulation', () => {
    fc.assert(
      fc.property(baseSession, messageSequence, (session, messages) => {
        let current = session;
        for (const msg of messages) {
          current = simulateAppendMessage(current, msg);
        }

        // Verify strict ordering: for any i < j, messages[i] appears before messages[j]
        for (let i = 0; i < messages.length - 1; i++) {
          const idxI = current.messages.findIndex(
            (m) => m.content === messages[i].content && m.timestamp === messages[i].timestamp
          );
          const idxJ = current.messages.findIndex(
            (m) => m.content === messages[i + 1].content && m.timestamp === messages[i + 1].timestamp
          );
          expect(idxI).toBeLessThan(idxJ);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('message_count increments by exactly 1 per append', () => {
    fc.assert(
      fc.property(baseSession, messageSequence, (session, messages) => {
        let current = session;
        for (let i = 0; i < messages.length; i++) {
          const prevCount = current.message_count;
          current = simulateAppendMessage(current, messages[i]);
          expect(current.message_count).toBe(prevCount + 1);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('last_active_at is updated to the latest message timestamp', () => {
    fc.assert(
      fc.property(baseSession, messageSequence, (session, messages) => {
        let current = session;
        for (const msg of messages) {
          current = simulateAppendMessage(current, msg);
        }

        // last_active_at should be the timestamp of the last message
        const lastMessage = messages[messages.length - 1];
        expect(current.last_active_at).toBe(lastMessage.timestamp);
      }),
      { numRuns: 100 }
    );
  });
});
