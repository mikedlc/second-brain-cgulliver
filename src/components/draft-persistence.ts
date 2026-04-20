/**
 * Draft Persistence Component
 *
 * Manages draft files in 00_System/Pending/ for conversation sessions.
 * Drafts are persisted proactively on every discuss message to prevent data loss.
 *
 * Validates: Requirements 13.11, 13.12, 13.13, 13.14, 13.15, 13.16, 13.17
 */

import {
  CodeCommitClient,
  GetBranchCommand,
  GetFileCommand,
  GetFolderCommand,
  CreateCommitCommand,
  FileDoesNotExistException,
  FolderDoesNotExistException,
} from '@aws-sdk/client-codecommit';
import type {
  ConversationSession,
  DraftFile,
  DraftFrontMatter,
} from '../types/conversation-session';
import type { KnowledgeStoreConfig } from './knowledge-store';

/** Pending drafts folder path */
const PENDING_FOLDER = '00_System/Pending';

/** CodeCommit client */
const codecommitClient = new CodeCommitClient({});

/**
 * Generate a URL-safe slug from a topic string.
 * - Lowercase
 * - Replace spaces with hyphens
 * - Remove non-alphanumeric except hyphens
 * - Truncate to 40 characters
 */
export function generateSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
}

/**
 * Build the draft file path for a session.
 * Format: 00_System/Pending/YYYY-MM-DD__<topic-slug>__<session_id>.md
 *
 * Validates: Requirement 13.12
 */
export function buildDraftPath(session: ConversationSession): string {
  const date = session.created_at.split('T')[0]; // YYYY-MM-DD
  const slug = generateSlug(session.topic);
  return `${PENDING_FOLDER}/${date}__${slug}__${session.discussion_id}.md`;
}

/**
 * Build the draft file content (YAML front matter + summary + transcript).
 *
 * Validates: Requirements 13.12, 13.13
 */
export function buildDraftContent(session: ConversationSession): string {
  const frontMatter = [
    '---',
    `session_id: ${session.discussion_id}`,
    `topic: ${session.topic}`,
    `related_area: ${session.related_area}`,
    'status: open',
    `created_at: ${session.created_at}`,
    `last_active_at: ${session.last_active_at}`,
    `message_count: ${session.message_count}`,
    '---',
  ].join('\n');

  const title = `\n\n# Discussion: ${session.topic}\n`;

  const summary = '\n## Summary\n\nConversation in progress.\n';

  let transcript = '\n## Conversation Transcript\n\n';
  for (const msg of session.messages) {
    const time = msg.timestamp.split('T')[1]?.split('.')[0] ?? msg.timestamp;
    const speaker = msg.role === 'user' ? 'User' : 'Bot';
    transcript += `**${speaker}** (${time}): ${msg.content}\n`;
  }

  return frontMatter + title + summary + transcript;
}

/**
 * Persist a draft file to CodeCommit (00_System/Pending/).
 * Overwrites any existing draft for the same session.
 *
 * Validates: Requirements 13.11, 13.12
 */
export async function persistDraft(
  session: ConversationSession,
  knowledgeConfig: KnowledgeStoreConfig
): Promise<void> {
  const draftPath = buildDraftPath(session);
  const content = buildDraftContent(session);

  const branchResponse = await codecommitClient.send(
    new GetBranchCommand({
      repositoryName: knowledgeConfig.repositoryName,
      branchName: knowledgeConfig.branchName,
    })
  );

  const parentCommitId = branchResponse.branch?.commitId;

  await codecommitClient.send(
    new CreateCommitCommand({
      repositoryName: knowledgeConfig.repositoryName,
      branchName: knowledgeConfig.branchName,
      parentCommitId,
      authorName: 'Second Brain Agent',
      email: 'agent@second-brain.local',
      commitMessage: `Draft: ${session.topic} (${session.discussion_id})`,
      putFiles: [
        {
          filePath: draftPath,
          fileContent: Buffer.from(content),
        },
      ],
    })
  );
}

/**
 * Load and parse a draft file from CodeCommit.
 * Returns a ConversationSession reconstructed from the draft.
 *
 * Validates: Requirement 13.15
 */
export async function loadDraft(
  draftPath: string,
  knowledgeConfig: KnowledgeStoreConfig
): Promise<ConversationSession | null> {
  try {
    const response = await codecommitClient.send(
      new GetFileCommand({
        repositoryName: knowledgeConfig.repositoryName,
        filePath: draftPath,
      })
    );

    if (!response.fileContent) {
      return null;
    }

    const raw = Buffer.from(response.fileContent).toString('utf-8');
    return parseDraftContent(raw, draftPath);
  } catch (error) {
    if (error instanceof FileDoesNotExistException) {
      return null;
    }
    throw error;
  }
}

/**
 * Parse draft file content into a ConversationSession.
 */
export function parseDraftContent(
  raw: string,
  draftPath: string
): ConversationSession | null {
  // Extract front matter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return null;
  }

  const fmBlock = fmMatch[1];
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fm[key] = value;
    }
  }

  // Extract session_id from path (last segment before .md, after last __)
  const pathSessionId = fm['session_id'] || '';

  // Parse transcript section
  const messages = parseTranscript(raw);

  // Reconstruct session_id (PK) from path — extract channel#user if available
  // For drafts, we use a placeholder session_id since the original PK isn't in the draft
  const sessionId = draftPath.replace(`${PENDING_FOLDER}/`, '').replace('.md', '');

  return {
    session_id: sessionId,
    discussion_id: pathSessionId,
    topic: fm['topic'] || '',
    related_area: fm['related_area'] || '',
    messages,
    status: 'active',
    created_at: fm['created_at'] || '',
    last_active_at: fm['last_active_at'] || '',
    message_count: parseInt(fm['message_count'] || '0', 10),
    expires_at: Math.floor(Date.now() / 1000) + 14400, // Reset TTL on load
  };
}

/**
 * Parse the conversation transcript section from draft content.
 */
function parseTranscript(
  raw: string
): Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [];

  // Find the transcript section
  const transcriptMatch = raw.match(/## Conversation Transcript\n\n([\s\S]*?)$/);
  if (!transcriptMatch) {
    return messages;
  }

  const transcriptBlock = transcriptMatch[1];
  const linePattern = /\*\*(User|Bot)\*\* \(([^)]+)\): (.*)/g;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(transcriptBlock)) !== null) {
    const role: 'user' | 'assistant' = match[1] === 'User' ? 'user' : 'assistant';
    const timestamp = match[2];
    const content = match[3];
    messages.push({ role, content, timestamp });
  }

  return messages;
}

/**
 * Delete a draft file from CodeCommit.
 *
 * Validates: Requirements 13.16, 13.17
 */
export async function deleteDraft(
  draftPath: string,
  knowledgeConfig: KnowledgeStoreConfig
): Promise<void> {
  const branchResponse = await codecommitClient.send(
    new GetBranchCommand({
      repositoryName: knowledgeConfig.repositoryName,
      branchName: knowledgeConfig.branchName,
    })
  );

  const parentCommitId = branchResponse.branch?.commitId;

  await codecommitClient.send(
    new CreateCommitCommand({
      repositoryName: knowledgeConfig.repositoryName,
      branchName: knowledgeConfig.branchName,
      parentCommitId,
      authorName: 'Second Brain Agent',
      email: 'agent@second-brain.local',
      commitMessage: `Delete draft: ${draftPath}`,
      deleteFiles: [{ filePath: draftPath }],
    })
  );
}

/**
 * List all draft files in 00_System/Pending/.
 * Returns a summary array with session metadata extracted from front matter.
 *
 * Validates: Requirement 13.14
 */
export async function listDrafts(
  knowledgeConfig: KnowledgeStoreConfig
): Promise<
  Array<{
    session_id: string;
    topic: string;
    last_active_at: string;
    message_count: number;
    path: string;
  }>
> {
  let filePaths: string[];

  try {
    const folderResponse = await codecommitClient.send(
      new GetFolderCommand({
        repositoryName: knowledgeConfig.repositoryName,
        folderPath: PENDING_FOLDER,
        commitSpecifier: knowledgeConfig.branchName,
      })
    );

    filePaths = (folderResponse.files ?? [])
      .map((f) => f.absolutePath)
      .filter((p): p is string => !!p && p.endsWith('.md'));
  } catch (error) {
    if (error instanceof FolderDoesNotExistException) {
      return [];
    }
    throw error;
  }

  const drafts: Array<{
    session_id: string;
    topic: string;
    last_active_at: string;
    message_count: number;
    path: string;
  }> = [];

  for (const filePath of filePaths) {
    try {
      const fileResponse = await codecommitClient.send(
        new GetFileCommand({
          repositoryName: knowledgeConfig.repositoryName,
          filePath,
        })
      );

      if (!fileResponse.fileContent) continue;

      const raw = Buffer.from(fileResponse.fileContent).toString('utf-8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm: Record<string, string> = {};
      for (const line of fmMatch[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          fm[key] = value;
        }
      }

      drafts.push({
        session_id: fm['session_id'] || '',
        topic: fm['topic'] || '',
        last_active_at: fm['last_active_at'] || '',
        message_count: parseInt(fm['message_count'] || '0', 10),
        path: filePath,
      });
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return drafts;
}
