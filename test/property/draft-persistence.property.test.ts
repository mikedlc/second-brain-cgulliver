/**
 * Property-Based Tests: Draft File Format Consistency
 *
 * Feature: organic-knowledge-filing, Property 10: Draft file format consistency
 *
 * **Validates: Requirements 13.12, 13.13**
 *
 * For any conversation session that is persisted as a draft, the draft file path SHALL
 * match the pattern 00_System/Pending/YYYY-MM-DD__<slug>__<session_id>.md where
 * <session_id> matches the session's discussion_id. The draft's YAML front matter SHALL
 * contain all required fields: session_id, topic, related_area, status (value: "open"),
 * created_at, last_active_at, and message_count.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { buildDraftPath, buildDraftContent } from '../../src/components/draft-persistence';
import type { ConversationSession, SessionMessage } from '../../src/types/conversation-session';

// --- Arbitraries ---

/** Generate a random session message */
const sessionMessage: fc.Arbitrary<SessionMessage> = fc.record({
  role: fc.constantFrom('user', 'assistant') as fc.Arbitrary<'user' | 'assistant'>,
  content: fc.string({ minLength: 1, maxLength: 300 }),
  timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2027-12-31') }).map(
    (d) => d.toISOString()
  ),
});

/** Generate a valid discussion_id */
const discussionId: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 7, maxLength: 7 })
  .map((hex) => `ds-${hex}`);

/** Generate a topic that produces a valid slug (trimmed, no leading/trailing whitespace) */
const topic: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
    ),
    { minLength: 1, maxLength: 60 }
  )
  .map((t) => t.trim())
  .filter((t) => t.length > 0);

/** Generate a random ConversationSession */
const conversationSession: fc.Arbitrary<ConversationSession> = fc
  .record({
    session_id: fc.string({ minLength: 5, maxLength: 30 }).map(
      (s) => `C123#U${s.replace(/[^a-zA-Z0-9]/g, 'x')}`
    ),
    discussion_id: discussionId,
    topic: topic,
    related_area: fc.constantFrom('10_Work', '20_Personal', '25_Real_Estate', '_INBOX', '00_System'),
    messages: fc.array(sessionMessage, { minLength: 0, maxLength: 20 }),
    status: fc.constant('active' as const),
    created_at: fc.date({ min: new Date('2024-01-01'), max: new Date('2027-12-31') }).map(
      (d) => d.toISOString()
    ),
    last_active_at: fc.date({ min: new Date('2024-01-01'), max: new Date('2027-12-31') }).map(
      (d) => d.toISOString()
    ),
    message_count: fc.nat({ max: 100 }),
    expires_at: fc.integer({ min: 1700000000, max: 2000000000 }),
  })
  .map((s) => ({
    ...s,
    message_count: s.messages.length,
  }));

describe('Property 10: Draft file format consistency', () => {
  it('draft path matches 00_System/Pending/YYYY-MM-DD__<slug>__<session_id>.md pattern', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const path = buildDraftPath(session);

        // Must start with 00_System/Pending/
        expect(path.startsWith('00_System/Pending/')).toBe(true);

        // Must end with .md
        expect(path.endsWith('.md')).toBe(true);

        // Extract filename
        const filename = path.replace('00_System/Pending/', '');

        // Must match YYYY-MM-DD__<slug>__<session_id>.md pattern
        const pattern = /^\d{4}-\d{2}-\d{2}__[a-z0-9-]*__ds-[a-f0-9]{7}\.md$/;
        expect(filename).toMatch(pattern);

        // session_id in path must match discussion_id
        expect(path).toContain(session.discussion_id);
      }),
      { numRuns: 100 }
    );
  });

  it('draft path date component matches session created_at date', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const path = buildDraftPath(session);
        const expectedDate = session.created_at.split('T')[0]; // YYYY-MM-DD
        const filename = path.replace('00_System/Pending/', '');
        const dateInPath = filename.split('__')[0];

        expect(dateInPath).toBe(expectedDate);
      }),
      { numRuns: 100 }
    );
  });

  it('draft content front matter contains all required fields', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const content = buildDraftContent(session);

        // Extract front matter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();

        const frontMatter = fmMatch![1];

        // Required fields
        expect(frontMatter).toContain('session_id:');
        expect(frontMatter).toContain('topic:');
        expect(frontMatter).toContain('related_area:');
        expect(frontMatter).toContain('status: open');
        expect(frontMatter).toContain('created_at:');
        expect(frontMatter).toContain('last_active_at:');
        expect(frontMatter).toContain('message_count:');
      }),
      { numRuns: 100 }
    );
  });

  it('draft front matter session_id matches session discussion_id', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const content = buildDraftContent(session);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();

        const frontMatter = fmMatch![1];
        const sessionIdLine = frontMatter.split('\n').find((l) => l.startsWith('session_id:'));
        expect(sessionIdLine).toBeDefined();

        const sessionIdValue = sessionIdLine!.split(':')[1].trim();
        expect(sessionIdValue).toBe(session.discussion_id);
      }),
      { numRuns: 100 }
    );
  });

  it('draft front matter topic matches session topic', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const content = buildDraftContent(session);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();

        const frontMatter = fmMatch![1];
        const topicLine = frontMatter.split('\n').find((l) => l.startsWith('topic:'));
        expect(topicLine).toBeDefined();

        const topicValue = topicLine!.slice('topic:'.length).trim();
        expect(topicValue).toBe(session.topic);
      }),
      { numRuns: 100 }
    );
  });

  it('draft front matter related_area matches session related_area', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const content = buildDraftContent(session);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();

        const frontMatter = fmMatch![1];
        const areaLine = frontMatter.split('\n').find((l) => l.startsWith('related_area:'));
        expect(areaLine).toBeDefined();

        const areaValue = areaLine!.slice('related_area:'.length).trim();
        expect(areaValue).toBe(session.related_area);
      }),
      { numRuns: 100 }
    );
  });

  it('draft front matter status is always "open"', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const content = buildDraftContent(session);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();

        const frontMatter = fmMatch![1];
        const statusLine = frontMatter.split('\n').find((l) => l.startsWith('status:'));
        expect(statusLine).toBeDefined();

        const statusValue = statusLine!.slice('status:'.length).trim();
        expect(statusValue).toBe('open');
      }),
      { numRuns: 100 }
    );
  });

  it('draft front matter message_count matches session message_count', () => {
    fc.assert(
      fc.property(conversationSession, (session) => {
        const content = buildDraftContent(session);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(fmMatch).not.toBeNull();

        const frontMatter = fmMatch![1];
        const countLine = frontMatter.split('\n').find((l) => l.startsWith('message_count:'));
        expect(countLine).toBeDefined();

        const countValue = parseInt(countLine!.slice('message_count:'.length).trim(), 10);
        expect(countValue).toBe(session.message_count);
      }),
      { numRuns: 100 }
    );
  });
});
