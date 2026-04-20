/**
 * Unit Tests: Draft Resume Round-Trip Fidelity
 *
 * Tests that a session can be serialized to draft content and parsed back
 * with identical messages, topic, related_area, and discussion_id.
 *
 * Validates: Requirements 13.15, 13.16
 */

import { describe, it, expect } from 'vitest';
import { buildDraftContent, parseDraftContent } from '../../src/components/draft-persistence';
import type { ConversationSession } from '../../src/types/conversation-session';

/** Helper to create a test session */
function createTestSession(overrides?: Partial<ConversationSession>): ConversationSession {
  return {
    session_id: 'C123#U456',
    discussion_id: 'ds-abc1234',
    topic: 'Solar panel options for workshop',
    related_area: '25_Real_Estate',
    messages: [
      {
        role: 'user',
        content: 'What are the options for solar panels on the workshop?',
        timestamp: '2026-04-20T10:00:00.000Z',
      },
      {
        role: 'assistant',
        content: 'Based on your workshop dimensions, you have three main options...',
        timestamp: '2026-04-20T10:00:30.000Z',
      },
      {
        role: 'user',
        content: 'What about the cost difference between monocrystalline and polycrystalline?',
        timestamp: '2026-04-20T10:05:00.000Z',
      },
      {
        role: 'assistant',
        content: 'Monocrystalline panels typically cost 20-30% more but offer higher efficiency...',
        timestamp: '2026-04-20T10:05:45.000Z',
      },
    ],
    status: 'active',
    created_at: '2026-04-20T10:00:00.000Z',
    last_active_at: '2026-04-20T10:05:45.000Z',
    message_count: 4,
    expires_at: 1745150400,
    ...overrides,
  };
}

describe('Draft resume round-trip fidelity', () => {
  it('session → buildDraftContent → parseDraftContent → restored session has identical messages', () => {
    const session = createTestSession();
    const draftContent = buildDraftContent(session);
    const draftPath = '00_System/Pending/2026-04-20__solar-panel-options-for-workshop__ds-abc1234.md';

    const restored = parseDraftContent(draftContent, draftPath);

    expect(restored).not.toBeNull();
    expect(restored!.messages).toHaveLength(session.messages.length);

    for (let i = 0; i < session.messages.length; i++) {
      expect(restored!.messages[i].role).toBe(session.messages[i].role);
      expect(restored!.messages[i].content).toBe(session.messages[i].content);
    }
  });

  it('session → buildDraftContent → parseDraftContent → restored session has identical topic', () => {
    const session = createTestSession();
    const draftContent = buildDraftContent(session);
    const draftPath = '00_System/Pending/2026-04-20__solar-panel-options-for-workshop__ds-abc1234.md';

    const restored = parseDraftContent(draftContent, draftPath);

    expect(restored).not.toBeNull();
    expect(restored!.topic).toBe(session.topic);
  });

  it('session → buildDraftContent → parseDraftContent → restored session has identical related_area', () => {
    const session = createTestSession();
    const draftContent = buildDraftContent(session);
    const draftPath = '00_System/Pending/2026-04-20__solar-panel-options-for-workshop__ds-abc1234.md';

    const restored = parseDraftContent(draftContent, draftPath);

    expect(restored).not.toBeNull();
    expect(restored!.related_area).toBe(session.related_area);
  });

  it('session → buildDraftContent → parseDraftContent → restored session has identical discussion_id', () => {
    const session = createTestSession();
    const draftContent = buildDraftContent(session);
    const draftPath = '00_System/Pending/2026-04-20__solar-panel-options-for-workshop__ds-abc1234.md';

    const restored = parseDraftContent(draftContent, draftPath);

    expect(restored).not.toBeNull();
    expect(restored!.discussion_id).toBe(session.discussion_id);
  });

  it('resumed session can continue accumulating messages (message_count increments correctly)', () => {
    const session = createTestSession();
    const draftContent = buildDraftContent(session);
    const draftPath = '00_System/Pending/2026-04-20__solar-panel-options-for-workshop__ds-abc1234.md';

    const restored = parseDraftContent(draftContent, draftPath);
    expect(restored).not.toBeNull();

    // Simulate appending a new message to the restored session
    const newMessage = {
      role: 'user' as const,
      content: 'Can you recommend an installer?',
      timestamp: '2026-04-20T11:00:00.000Z',
    };

    const updatedSession: ConversationSession = {
      ...restored!,
      messages: [...restored!.messages, newMessage],
      message_count: restored!.message_count + 1,
      last_active_at: newMessage.timestamp,
    };

    // Verify message_count incremented correctly
    expect(updatedSession.message_count).toBe(session.message_count + 1);
    expect(updatedSession.messages).toHaveLength(session.messages.length + 1);
    expect(updatedSession.messages[updatedSession.messages.length - 1].content).toBe(
      'Can you recommend an installer?'
    );
  });

  it('resume with non-existent draft returns null', () => {
    // parseDraftContent with invalid/empty content should return null
    const result = parseDraftContent('', 'non-existent-path.md');
    expect(result).toBeNull();
  });

  it('resume with malformed front matter returns null', () => {
    const malformedContent = 'This is just plain text without front matter';
    const result = parseDraftContent(malformedContent, 'some-path.md');
    expect(result).toBeNull();
  });

  it('round-trip preserves message order for sessions with many messages', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message number ${i + 1} with some content`,
      timestamp: `2026-04-20T${String(10 + Math.floor(i / 4)).padStart(2, '0')}:${String((i * 15) % 60).padStart(2, '0')}:00.000Z`,
    }));

    const session = createTestSession({
      messages,
      message_count: messages.length,
    });

    const draftContent = buildDraftContent(session);
    const draftPath = '00_System/Pending/2026-04-20__solar-panel-options-for-workshop__ds-abc1234.md';
    const restored = parseDraftContent(draftContent, draftPath);

    expect(restored).not.toBeNull();
    expect(restored!.messages).toHaveLength(messages.length);

    for (let i = 0; i < messages.length; i++) {
      expect(restored!.messages[i].role).toBe(messages[i].role);
      expect(restored!.messages[i].content).toBe(messages[i].content);
    }
  });
});
