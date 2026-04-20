/**
 * Worker Lambda Handler (v2.1)
 * 
 * Processes Slack events from SQS:
 * - Idempotency check (DynamoDB)
 * - Load system prompt (CodeCommit)
 * - Invoke AgentCore Runtime for classification
 * - Validate Action Plan
 * - Execute side effects: CodeCommit → SES → Slack
 * - Write receipt
 * 
 * Validates: Requirements 3, 6, 11, 15, 17, 19-22, 42-44
 */

import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import type { SQSEventMessage, Classification } from '../types';
import {
  tryAcquireLock,
  updateExecutionState,
  markCompleted,
  markFailed,
  type IdempotencyConfig,
} from '../components/idempotency-guard';
import {
  loadSystemPrompt,
  type SystemPromptConfig,
} from '../components/system-prompt-loader';
import {
  invokeAgentRuntime,
  shouldAskClarification,
  generateClarificationPrompt,
  type AgentCoreConfig,
} from '../components/agentcore-client';
import {
  validateActionPlan,
  type ActionPlan,
} from '../components/action-plan';
import {
  executeActionPlan,
  type ExecutorConfig,
} from '../components/action-executor';
import type { FilingPlan } from '../types/filing-plan';
import {
  validateFilingPlan,
  parseFilingPlanFromLLM,
} from '../components/filing-plan-validator';
import {
  executeFilingPlan,
  type FilingExecutorConfig,
} from '../components/filing-executor';
import {
  getActiveSession,
  createSession,
  appendMessage,
  markSessionFiled,
  markSessionDiscarded,
  type SessionStoreConfig,
} from '../components/conversation-session-store';
import {
  persistDraft,
  loadDraft,
  deleteDraft,
  listDrafts,
  buildDraftPath,
} from '../components/draft-persistence';
import {
  retrieveFSI,
  persistFSI,
} from '../components/fsi-memory-client';
import {
  createReceipt,
  appendReceipt,
  type SlackContext,
} from '../components/receipt-logger';
import {
  getContext,
  setContext,
  deleteContext,
  type ConversationStoreConfig,
} from '../components/conversation-context';
import {
  formatConfirmationReply,
  formatClarificationReply,
  formatErrorReply,
  sendSlackReply,
} from '../components/slack-responder';
import {
  parseFixCommand,
  getFixableReceipt,
  applyFix,
  canApplyFix,
  detectReclassifyRequest,
  extractOriginalMessage,
} from '../components/fix-handler';
import {
  findMatchingProject,
  type ProjectMatcherConfig,
} from '../components/project-matcher';
import type { KnowledgeStoreConfig } from '../components/knowledge-store';
import { readFile, deleteFile } from '../components/knowledge-store';
import {
  searchKnowledgeBase,
  type KnowledgeSearchConfig,
} from '../components/knowledge-search';
import {
  processQuery,
  buildQueryPrompt,
  generateNoResultsResponse,
  formatQuerySlackReply,
  validateResponseCitations,
  queryProjectsByStatus,
  formatProjectQueryForSlack,
} from '../components/query-handler';
import {
  updateProjectStatus,
} from '../components/project-status-updater';
import type { ProjectStatus } from '../components/action-plan';
import {
  isMultiItemResponse,
  validateMultiItemResponse,
  type MultiItemResponse,
} from '../components/action-plan';
import {
  appendTaskLog,
  appendReferenceLog,
} from '../components/task-logger';
import {
  invokeSyncItem,
  invokeSyncAll,
  invokeDeleteItem,
  invokeHealthCheck,
  invokeRepair,
  type SyncInvokerConfig,
  type SyncResponse,
  type HealthReport,
} from '../components/sync-invoker';
import { log, redactPII } from './logging';
import { createHash } from 'crypto';

// =========================================================================
// FINDING-AI-01: Input sanitization for prompt injection mitigation
// Strips control characters and limits message length before passing to LLM.
// The classifier only returns JSON and cannot execute actions, so this is
// defense-in-depth rather than a critical control.
// =========================================================================
const MAX_MESSAGE_LENGTH = 10_000; // 10K chars — generous for personal use

function sanitizeInput(text: string): string {
  // Strip control characters (except newline, tab, carriage return)
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Truncate to max length
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = sanitized.substring(0, MAX_MESSAGE_LENGTH);
  }

  return sanitized;
}

// Environment variables
const REPOSITORY_NAME = process.env.REPOSITORY_NAME!;
const IDEMPOTENCY_TABLE = process.env.IDEMPOTENCY_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;
const BOT_TOKEN_PARAM = process.env.BOT_TOKEN_PARAM || '/second-brain/slack-bot-token';
const MAILDROP_PARAM = process.env.MAILDROP_PARAM || '/second-brain/omnifocus-maildrop-email';
const CONVERSATION_TTL_PARAM = process.env.CONVERSATION_TTL_PARAM || '/second-brain/conversation-ttl-seconds';
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@example.com';
const EMAIL_MODE = process.env.EMAIL_MODE || 'live';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Configuration objects
const idempotencyConfig: IdempotencyConfig = {
  tableName: IDEMPOTENCY_TABLE,
  ttlDays: 7,
};

const knowledgeConfig: KnowledgeStoreConfig = {
  repositoryName: REPOSITORY_NAME,
  branchName: 'main',
};

const conversationConfig: ConversationStoreConfig = {
  tableName: CONVERSATION_TABLE,
  ttlParam: CONVERSATION_TTL_PARAM,
};

const agentConfig: AgentCoreConfig = {
  agentRuntimeArn: AGENT_RUNTIME_ARN,
  region: AWS_REGION,
};

const systemPromptConfig: SystemPromptConfig = {
  repositoryName: REPOSITORY_NAME,
  branchName: 'main',
  promptPath: '00_System/agent-system-prompt.md',
};

// Project matcher configuration
const projectMatcherConfig: ProjectMatcherConfig = {
  repositoryName: REPOSITORY_NAME,
  branchName: 'main',
  minConfidence: 0.5,
  autoLinkConfidence: 0.7,
  maxCandidates: 3,
};

// Sync invoker configuration - uses AgentCore classifier for sync operations
const syncConfig: SyncInvokerConfig = {
  agentRuntimeArn: AGENT_RUNTIME_ARN,
  region: AWS_REGION,
};

// Session store configuration for discuss mode
const sessionStoreConfig: SessionStoreConfig = {
  tableName: CONVERSATION_TABLE,
};

// Filing executor configuration
const filingExecutorConfig: FilingExecutorConfig = {
  repositoryName: REPOSITORY_NAME,
  branchName: 'main',
  actorId: '', // Set per-request from user_id
};

// Cached system prompt
let cachedSystemPrompt: { content: string; metadata: { commitId: string; sha256: string } } | null = null;

/**
 * Load system prompt (cached for Lambda lifetime)
 */
async function getSystemPrompt(): Promise<{ content: string; metadata: { commitId: string; sha256: string } }> {
  if (cachedSystemPrompt) {
    return cachedSystemPrompt;
  }

  const result = await loadSystemPrompt(systemPromptConfig);
  cachedSystemPrompt = {
    content: result.content,
    metadata: {
      commitId: result.metadata.commitId,
      sha256: result.metadata.sha256,
    },
  };
  
  log('info', 'System prompt loaded', {
    hash: result.metadata.sha256.substring(0, 8),
    commitId: result.metadata.commitId,
  });

  return cachedSystemPrompt;
}

/**
 * Process a single SQS message
 * 
 * Validates: Requirements 3.3, 6, 11, 15, 17, 19-22, 42-44
 */
async function processMessage(message: SQSEventMessage): Promise<void> {
  const { event_id, user_id, channel_id, message_text, message_ts, thread_ts } = message;

  log('info', 'Processing message', {
    event_id,
    user_id: redactPII(user_id),
    channel_id,
  });

  // Build Slack context
  const slackContext: SlackContext = {
    user_id,
    channel_id,
    message_ts,
    thread_ts,
  };

  // Step 1: Idempotency check
  const lockAcquired = await tryAcquireLock(idempotencyConfig, event_id);
  if (!lockAcquired) {
    log('info', 'Duplicate event, skipping', { event_id });
    return;
  }

  await updateExecutionState(idempotencyConfig, event_id, { status: 'RECEIVED' });

  try {
    // Step 2: Check for fix command
    const fixCommand = parseFixCommand(message_text);
    if (fixCommand.isFixCommand) {
      await handleFixCommand(event_id, slackContext, fixCommand.instruction);
      return;
    }

    // Step 2.5: Check for health/rebuild/repair command
    // Validates: Requirements 5.1
    if (isHealthCommand(message_text)) {
      const text = message_text.trim().toLowerCase();
      const isRebuild = text === 'rebuild';
      const isRepair = text === 'repair';
      await handleHealthCommand(event_id, slackContext, isRebuild, isRepair);
      return;
    }

    // Step 3: Check for existing conversation context (clarification response)
    const existingContext = await getContext(conversationConfig, channel_id, user_id);
    if (existingContext) {
      await handleClarificationResponse(event_id, slackContext, message_text, existingContext);
      return;
    }

    // Step 4: Load system prompt
    const systemPrompt = await getSystemPrompt();

    // Step 5: Invoke AgentCore for classification
    await updateExecutionState(idempotencyConfig, event_id, { status: 'PLANNED' });

    const agentResult = await invokeAgentRuntime(agentConfig, {
      prompt: sanitizeInput(message_text),
      system_prompt: systemPrompt.content,
      session_id: `${channel_id}#${user_id}`,
      user_id: user_id,
    });

    // Step 5.5: Check for multi-item response (legacy path)
    if (agentResult.success && agentResult.multiItemResponse) {
      await handleMultiItemMessage(event_id, slackContext, agentResult.multiItemResponse, systemPrompt);
      return;
    }

    if (!agentResult.success) {
      // Log raw response for debugging if available
      if (agentResult.rawResponse) {
        log('error', 'AgentCore raw response', {
          event_id,
          rawResponse: agentResult.rawResponse,
        });
      }
      throw new Error(agentResult.error || 'AgentCore invocation failed');
    }

    // Step 6: Try to parse as FilingPlan first, fall back to ActionPlan
    const rawResponse = agentResult.rawResponse || '';
    const filingPlan = agentResult.actionPlan
      ? null // If agentcore-client already parsed it, we handle below
      : parseFilingPlanFromLLM(rawResponse);

    // If we got a FilingPlan (either parsed from raw or from actionPlan), route on intent
    const parsedFilingPlan: FilingPlan | null = filingPlan || (agentResult.actionPlan ? agentResult.actionPlan as unknown as FilingPlan : null);

    if (!parsedFilingPlan) {
      throw new Error('Failed to parse response from AgentCore');
    }

    log('info', 'Classification result', {
      event_id,
      intent: parsedFilingPlan.intent,
      intent_confidence: parsedFilingPlan.intent_confidence,
      action: parsedFilingPlan.action,
      file_path: parsedFilingPlan.file_path,
      has_query_response: !!parsedFilingPlan.query_response,
      has_cited_files: !!parsedFilingPlan.cited_files,
      has_linked_items: !!parsedFilingPlan.linked_items,
      linked_items_count: parsedFilingPlan.linked_items?.length || 0,
    });

    // Step 6.5: Validate Filing Plan
    const validation = validateFilingPlan(parsedFilingPlan);
    if (!validation.valid) {
      log('warn', 'Filing Plan validation errors', {
        event_id,
        errors: validation.errors,
        filingPlan: JSON.stringify(parsedFilingPlan).substring(0, 1000),
      });
      await handleValidationFailure(event_id, slackContext, validation.errors);
      return;
    }

    // Step 7: Route based on Filing Plan intent
    switch (parsedFilingPlan.intent) {
      case 'query': {
        // Preserve existing query handler — cast to ActionPlan for backward compat
        const actionPlan = parsedFilingPlan as unknown as ActionPlan;
        await handleQueryIntent(event_id, slackContext, message_text, actionPlan, systemPrompt);
        return;
      }

      case 'status_update': {
        // Preserve existing status update handler
        const actionPlan = parsedFilingPlan as unknown as ActionPlan;
        if (actionPlan.status_update) {
          await handleStatusUpdate(event_id, slackContext, actionPlan);
          return;
        }
        // Fall through to capture if no status_update details
        break;
      }

      case 'discuss': {
        await handleDiscussMode(event_id, slackContext, message_text, parsedFilingPlan, systemPrompt);
        return;
      }

      case 'capture':
      default: {
        // Execute filing plan via the new filing executor
        await executeCaptureIntent(event_id, slackContext, parsedFilingPlan, systemPrompt);
        return;
      }
    }

  } catch (error) {
    log('error', 'Processing failed', {
      event_id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    await markFailed(idempotencyConfig, event_id, error instanceof Error ? error.message : 'Unknown error');

    // Send error reply to user
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: channel_id,
        text: formatErrorReply('Processing failed. Please try again.'),
        thread_ts,
      }
    );

    throw error;
  }
}

/**
 * Execute a capture intent via the Filing Executor
 *
 * Validates: Requirements 7.1–7.10, 10.1, 10.3, 10.4
 */
async function executeCaptureIntent(
  eventId: string,
  slackContext: SlackContext,
  filingPlan: FilingPlan,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  const config: FilingExecutorConfig = {
    repositoryName: REPOSITORY_NAME,
    branchName: 'main',
    actorId: slackContext.user_id,
  };

  // Retrieve FSI from CodeCommit
  let fsi = await retrieveFSI(REPOSITORY_NAME, 'main');
  if (!fsi) {
    // Use empty FSI if retrieval fails
    fsi = {
      version: 1,
      last_updated: new Date().toISOString(),
      commit_id: '',
      entries: [],
    };
    log('warn', 'FSI retrieval failed, using empty FSI', { event_id: eventId });
  }

  // Execute the filing plan
  const result = await executeFilingPlan(
    filingPlan,
    config,
    fsi,
    async (updatedFSI) => {
      await persistFSI(REPOSITORY_NAME, 'main', updatedFSI);
    }
  );

  if (!result.success) {
    log('warn', 'Filing execution failed', {
      event_id: eventId,
      error: result.error,
      warnings: result.warnings,
    });

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply(result.error || 'Filing failed'),
        thread_ts: slackContext.thread_ts,
      }
    );

    await markFailed(idempotencyConfig, eventId, result.error || 'Filing failed');
    return;
  }

  // Handle delete confirmation flow
  if (result.confirmationRequired) {
    // Store pending delete in conversation context for two-step confirmation
    await setContext(conversationConfig, slackContext.channel_id, slackContext.user_id, {
      original_event_id: eventId,
      original_message: JSON.stringify(filingPlan),
      original_classification: 'delete-confirm' as Classification,
      original_confidence: filingPlan.intent_confidence,
      clarification_asked: `Delete ${filingPlan.file_path}? Reply 'yes' to confirm.`,
    });

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: `⚠️ Delete \`${filingPlan.file_path}\`? Reply *yes* to confirm.`,
        thread_ts: slackContext.thread_ts,
      }
    );

    await markCompleted(idempotencyConfig, eventId);
    return;
  }

  // Send Slack confirmation
  const warningText = result.warnings.length > 0
    ? `\n⚠️ ${result.warnings.join('\n⚠️ ')}`
    : '';

  const confirmationText = `✅ Filed: *${filingPlan.title}*\n📁 \`${filingPlan.file_path}\` (${filingPlan.action})${warningText}`;

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: confirmationText,
      thread_ts: slackContext.thread_ts,
    }
  );

  // Create receipt
  const receipt = createReceipt(
    eventId,
    slackContext,
    'capture' as Classification,
    filingPlan.intent_confidence,
    [{ type: 'commit', status: 'success', details: { commitId: result.commitId } }],
    [filingPlan.file_path],
    result.commitId || null,
    `Filed: ${filingPlan.title} → ${filingPlan.file_path}`
  );

  await appendReceipt(knowledgeConfig, receipt);

  // Sync to Memory (fire-and-forget)
  if (AGENT_RUNTIME_ARN && result.commitId) {
    invokeSyncItem(syncConfig, {
      operation: 'sync_item',
      actorId: slackContext.user_id,
      itemPath: filingPlan.file_path,
      itemContent: filingPlan.content,
      commitId: result.commitId,
    }).catch(err => {
      log('warn', 'Post-filing sync failed', { event_id: eventId, error: err instanceof Error ? err.message : 'Unknown' });
    });
  }

  await markCompleted(idempotencyConfig, eventId, result.commitId);

  log('info', 'Capture completed', {
    event_id: eventId,
    file_path: filingPlan.file_path,
    action: filingPlan.action,
    commit_id: result.commitId,
  });
}

/**
 * Handle discuss mode interaction
 *
 * Manages conversational sessions: create/continue sessions, persist drafts,
 * handle "file this", "resume", "discard", and "list drafts" commands.
 *
 * Validates: Requirements 13.1–13.18
 */
async function handleDiscussMode(
  eventId: string,
  slackContext: SlackContext,
  messageText: string,
  filingPlan: FilingPlan,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  const normalizedText = messageText.trim().toLowerCase();

  // Handle "list drafts" / "what conversations are open?"
  if (normalizedText.match(/^(list\s+drafts?|what\s+conversations?\s+(are\s+)?open|show\s+(my\s+)?pending\s+threads?)$/i)) {
    await handleListDrafts(eventId, slackContext);
    return;
  }

  // Handle "resume ds-xxxxx" or "resume <topic>"
  const resumeMatch = normalizedText.match(/^resume\s+(.+)$/i);
  if (resumeMatch) {
    await handleResumeDraft(eventId, slackContext, resumeMatch[1].trim(), systemPrompt);
    return;
  }

  // Handle "discard ds-xxxxx"
  const discardMatch = normalizedText.match(/^discard\s+(.+)$/i);
  if (discardMatch) {
    await handleDiscardDraft(eventId, slackContext, discardMatch[1].trim());
    return;
  }

  // Handle "file this" / "save this" / "commit this" / "record this"
  if (normalizedText.match(/^(file|save|commit|record)\s+this$/i)) {
    await handleFileThis(eventId, slackContext, systemPrompt);
    return;
  }

  // Normal discuss flow: create or continue session
  let session = await getActiveSession(sessionStoreConfig, slackContext.channel_id, slackContext.user_id);

  if (!session) {
    // Create new session
    const topic = filingPlan.title || messageText.substring(0, 100);
    const relatedArea = filingPlan.file_path?.split('/')[0] || '_INBOX';
    session = await createSession(
      sessionStoreConfig,
      slackContext.channel_id,
      slackContext.user_id,
      topic,
      relatedArea
    );
    log('info', 'Created new discuss session', {
      event_id: eventId,
      discussion_id: session.discussion_id,
      topic,
    });
  }

  // Append user message to session
  await appendMessage(sessionStoreConfig, session.session_id, 'user', messageText);
  session.messages.push({ role: 'user', content: messageText, timestamp: new Date().toISOString() });
  session.message_count += 1;
  session.last_active_at = new Date().toISOString();

  // Persist draft to 00_System/Pending/ on every message
  try {
    await persistDraft(session, knowledgeConfig);
  } catch (err) {
    log('warn', 'Draft persistence failed', {
      event_id: eventId,
      error: err instanceof Error ? err.message : 'Unknown',
    });
  }

  // Send conversational Slack reply using discuss_response from Filing Plan
  const replyText = filingPlan.discuss_response || 'I\'m thinking about that. Could you tell me more?';

  // Append assistant message to session
  await appendMessage(sessionStoreConfig, session.session_id, 'assistant', replyText);

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: replyText,
      thread_ts: slackContext.thread_ts,
    }
  );

  // Create receipt
  const receipt = createReceipt(
    eventId,
    slackContext,
    'discuss' as Classification,
    filingPlan.intent_confidence,
    [{ type: 'slack_reply', status: 'success', details: { type: 'discuss_response' } }],
    [],
    null,
    `Discussion: ${session.topic} (${session.discussion_id})`
  );

  await appendReceipt(knowledgeConfig, receipt);
  await markCompleted(idempotencyConfig, eventId);

  log('info', 'Discuss mode completed', {
    event_id: eventId,
    discussion_id: session.discussion_id,
    message_count: session.message_count,
  });
}

/**
 * Handle "file this" command — file the current discussion session
 */
async function handleFileThis(
  eventId: string,
  slackContext: SlackContext,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  const session = await getActiveSession(sessionStoreConfig, slackContext.channel_id, slackContext.user_id);

  if (!session) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: 'No active discussion to file. Start a conversation first.',
        thread_ts: slackContext.thread_ts,
      }
    );
    await markCompleted(idempotencyConfig, eventId);
    return;
  }

  // Build conversation context for the Classifier
  const conversationContext = session.messages
    .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
    .join('\n');

  // Re-invoke Classifier with full conversation to produce a capture FilingPlan
  const agentResult = await invokeAgentRuntime(agentConfig, {
    prompt: `File this conversation as knowledge. Topic: ${session.topic}\n\nConversation:\n${conversationContext}`,
    system_prompt: systemPrompt.content,
    session_id: `${slackContext.channel_id}#${slackContext.user_id}`,
    user_id: slackContext.user_id,
  });

  if (!agentResult.success || !agentResult.actionPlan) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Failed to produce filing plan from conversation'),
        thread_ts: slackContext.thread_ts,
      }
    );
    await markFailed(idempotencyConfig, eventId, 'Failed to produce filing plan from conversation');
    return;
  }

  // Execute the capture filing plan
  const capturePlan = agentResult.actionPlan as unknown as FilingPlan;
  capturePlan.intent = 'capture';

  await executeCaptureIntent(eventId, slackContext, capturePlan, systemPrompt);

  // Mark session as filed and delete draft
  await markSessionFiled(sessionStoreConfig, session.session_id);
  try {
    const draftPath = buildDraftPath(session);
    await deleteDraft(draftPath, knowledgeConfig);
  } catch (err) {
    log('warn', 'Failed to delete draft after filing', {
      event_id: eventId,
      error: err instanceof Error ? err.message : 'Unknown',
    });
  }

  log('info', 'Discussion filed', {
    event_id: eventId,
    discussion_id: session.discussion_id,
  });
}

/**
 * Handle "resume ds-xxxxx" command — resume a draft discussion
 */
async function handleResumeDraft(
  eventId: string,
  slackContext: SlackContext,
  identifier: string,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  // Search for draft by session ID or topic
  const drafts = await listDrafts(knowledgeConfig);
  const matchingDraft = drafts.find(d =>
    d.session_id === identifier ||
    d.topic.toLowerCase().includes(identifier.toLowerCase())
  );

  if (!matchingDraft) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: `Draft not found: "${identifier}". Use "list drafts" to see available drafts.`,
        thread_ts: slackContext.thread_ts,
      }
    );
    await markCompleted(idempotencyConfig, eventId);
    return;
  }

  // Load the draft and restore session
  const restoredSession = await loadDraft(matchingDraft.path, knowledgeConfig);
  if (!restoredSession) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: `Failed to load draft: "${identifier}"`,
        thread_ts: slackContext.thread_ts,
      }
    );
    await markFailed(idempotencyConfig, eventId, 'Failed to load draft');
    return;
  }

  // Recreate session in DynamoDB
  const newSession = await createSession(
    sessionStoreConfig,
    slackContext.channel_id,
    slackContext.user_id,
    restoredSession.topic,
    restoredSession.related_area
  );

  // Replay messages into the new session
  for (const msg of restoredSession.messages) {
    await appendMessage(sessionStoreConfig, newSession.session_id, msg.role, msg.content);
  }

  const summaryText = `📝 Resumed discussion: *${restoredSession.topic}* (${restoredSession.messages.length} messages). Continue where you left off.`;

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: summaryText,
      thread_ts: slackContext.thread_ts,
    }
  );

  await markCompleted(idempotencyConfig, eventId);

  log('info', 'Draft resumed', {
    event_id: eventId,
    discussion_id: matchingDraft.session_id,
    topic: matchingDraft.topic,
  });
}

/**
 * Handle "discard ds-xxxxx" command — delete a draft
 */
async function handleDiscardDraft(
  eventId: string,
  slackContext: SlackContext,
  identifier: string
): Promise<void> {
  const drafts = await listDrafts(knowledgeConfig);
  const matchingDraft = drafts.find(d =>
    d.session_id === identifier ||
    d.topic.toLowerCase().includes(identifier.toLowerCase())
  );

  if (!matchingDraft) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: `Draft not found: "${identifier}". Use "list drafts" to see available drafts.`,
        thread_ts: slackContext.thread_ts,
      }
    );
    await markCompleted(idempotencyConfig, eventId);
    return;
  }

  // Delete the draft
  await deleteDraft(matchingDraft.path, knowledgeConfig);

  // Mark session as discarded if it exists
  const sessionId = `${slackContext.channel_id}#${slackContext.user_id}`;
  try {
    await markSessionDiscarded(sessionStoreConfig, sessionId);
  } catch {
    // Session may not exist in DynamoDB (already expired)
  }

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: `🗑️ Discarded draft: *${matchingDraft.topic}* (${matchingDraft.session_id})`,
      thread_ts: slackContext.thread_ts,
    }
  );

  await markCompleted(idempotencyConfig, eventId);

  log('info', 'Draft discarded', {
    event_id: eventId,
    discussion_id: matchingDraft.session_id,
  });
}

/**
 * Handle "list drafts" command — list all pending drafts
 */
async function handleListDrafts(
  eventId: string,
  slackContext: SlackContext
): Promise<void> {
  const drafts = await listDrafts(knowledgeConfig);

  if (drafts.length === 0) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: 'No pending discussions.',
        thread_ts: slackContext.thread_ts,
      }
    );
    await markCompleted(idempotencyConfig, eventId);
    return;
  }

  const lines = ['📋 *Pending Discussions:*', ''];
  for (const draft of drafts) {
    const lastActive = draft.last_active_at.split('T')[0];
    lines.push(`• *${draft.topic}* — ${draft.message_count} messages, last active ${lastActive} (\`${draft.session_id}\`)`);
  }
  lines.push('', 'Use `resume <session_id>` to continue or `discard <session_id>` to delete.');

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: lines.join('\n'),
      thread_ts: slackContext.thread_ts,
    }
  );

  await markCompleted(idempotencyConfig, eventId);

  log('info', 'Listed drafts', {
    event_id: eventId,
    draft_count: drafts.length,
  });
}

/**
 * Handle fix command
 * 
 * Supports two modes:
 * 1. Content fix: "fix: change the title to X" - edits the file content
 * 2. Reclassification: "fix: this should be a task" - re-processes as new classification
 */
async function handleFixCommand(
  eventId: string,
  slackContext: SlackContext,
  instruction: string
): Promise<void> {
  log('info', 'Processing fix command', { event_id: eventId, instruction });

  // Get the most recent fixable receipt
  const priorReceipt = await getFixableReceipt(knowledgeConfig, slackContext.user_id);
  const canFix = canApplyFix(priorReceipt);

  if (!canFix.canFix) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply(canFix.reason || 'Cannot apply fix'),
        thread_ts: slackContext.thread_ts,
      }
    );
    await markFailed(idempotencyConfig, eventId, canFix.reason || 'Cannot apply fix');
    return;
  }

  // Check if this is a reclassification request
  const reclassifyRequest = detectReclassifyRequest(instruction);
  
  if (reclassifyRequest.isReclassify && reclassifyRequest.targetClassification) {
    await handleReclassification(
      eventId,
      slackContext,
      priorReceipt!,
      reclassifyRequest.targetClassification
    );
    return;
  }

  // Standard content fix
  const systemPrompt = await getSystemPrompt();
  const fixResult = await applyFix(
    knowledgeConfig,
    agentConfig,
    priorReceipt!,
    instruction,
    systemPrompt.content,
    slackContext.user_id
  );

  if (!fixResult.success) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply(fixResult.error || 'Fix failed'),
        thread_ts: slackContext.thread_ts,
      }
    );
    await markFailed(idempotencyConfig, eventId, fixResult.error || 'Fix failed');
    return;
  }

  // Create receipt for fix
  const receipt = createReceipt(
    eventId,
    slackContext,
    'fix',
    1.0,
    [{ type: 'commit', status: 'success', details: { commitId: fixResult.commitId } }],
    fixResult.filesModified || [],
    fixResult.commitId || null,
    `Fix applied: ${instruction.substring(0, 50)}`,
    { priorCommitId: fixResult.priorCommitId }
  );

  await appendReceipt(knowledgeConfig, receipt);

  // Send confirmation
  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: formatConfirmationReply('fix', fixResult.filesModified || [], fixResult.commitId || null),
      thread_ts: slackContext.thread_ts,
    }
  );

  // Notify classifier of commit for background sync (fire-and-forget)
  // Fix operations may modify content in ways we don't have readily available,
  // so we use sync_all to let the classifier figure out what changed
  if (AGENT_RUNTIME_ARN && fixResult.filesModified?.length) {
    invokeSyncAll(syncConfig, {
      operation: 'sync_all',
      actorId: slackContext.user_id,
    }).then(syncResult => {
      log('info', 'Fix post-commit sync completed', { 
        event_id: eventId, 
        items_synced: syncResult.itemsSynced,
        success: syncResult.success,
      });
    }).catch(err => {
      log('warn', 'Fix post-commit sync failed', { event_id: eventId, error: err instanceof Error ? err.message : 'Unknown' });
    });
  }

  await markCompleted(idempotencyConfig, eventId);
  log('info', 'Fix completed', { event_id: eventId, commit_id: fixResult.commitId });
}

/**
 * Check if message is a health command (case-insensitive)
 * 
 * Validates: Requirements 5.1
 */
function isHealthCommand(messageText: string): boolean {
  const text = messageText.trim().toLowerCase();
  return text === 'health' || text === 'rebuild' || text === 'repair';
}

/**
 * Format health report for Slack reply
 * 
 * Validates: Requirements 5.5, 5.6
 */
function formatHealthReportForSlack(healthReport: HealthReport): string {
  const lines: string[] = ['📊 *Sync Health Report*', ''];

  // Item counts - Memory shows "records" since it includes historical events
  lines.push(`CodeCommit: ${healthReport.codecommitCount} items`);
  lines.push(`Memory: ${healthReport.memoryCount} records`);

  // Sync status with emoji
  if (healthReport.inSync) {
    lines.push('Status: ✅ In sync');
  } else {
    lines.push('Status: ⚠️ Out of sync');
  }

  // Missing items in Memory (up to 10)
  if (healthReport.missingInMemory.length > 0) {
    lines.push('');
    lines.push('Missing in Memory:');
    const itemsToShow = healthReport.missingInMemory.slice(0, 10);
    for (const item of itemsToShow) {
      lines.push(`• ${item}`);
    }
    if (healthReport.missingInMemory.length > 10) {
      lines.push(`• ... and ${healthReport.missingInMemory.length - 10} more`);
    }
  }

  // Extra items in Memory (up to 10)
  if (healthReport.extraInMemory.length > 0) {
    lines.push('');
    lines.push('Extra in Memory:');
    const itemsToShow = healthReport.extraInMemory.slice(0, 10);
    for (const item of itemsToShow) {
      lines.push(`• ${item}`);
    }
    if (healthReport.extraInMemory.length > 10) {
      lines.push(`• ... and ${healthReport.extraInMemory.length - 10} more`);
    }
  }

  // Current commit info
  lines.push('');
  if (healthReport.lastSyncCommitId) {
    // Show first 7 characters of commit ID
    lines.push(`HEAD: ${healthReport.lastSyncCommitId.substring(0, 7)}`);
  }

  // Suggestion to fix if out of sync
  if (!healthReport.inSync) {
    lines.push('');
    lines.push('Items sync automatically after each capture.');
  }

  return lines.join('\n');
}

/**
 * Handle health command (or rebuild/repair command)
 * 
 * Invokes the classifier with health_check operation and reports results.
 * If rebuild=true, forces a full sync before health check.
 * If repair=true, syncs only missing items (no duplicates).
 * 
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
async function handleHealthCommand(
  eventId: string,
  slackContext: SlackContext,
  rebuild: boolean = false,
  repair: boolean = false
): Promise<void> {
  const commandType = rebuild ? 'rebuild' : repair ? 'repair' : 'health';
  log('info', `Processing ${commandType} command`, { event_id: eventId });

  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  try {
    // Check if AgentCore Runtime is configured (health check uses the classifier)
    if (!AGENT_RUNTIME_ARN) {
      await sendSlackReply(
        { botTokenParam: BOT_TOKEN_PARAM },
        {
          channel: slackContext.channel_id,
          text: formatErrorReply('AgentCore Runtime not configured'),
          thread_ts: slackContext.thread_ts,
        }
      );
      await markFailed(idempotencyConfig, eventId, 'AgentCore Runtime not configured');
      return;
    }

    // If rebuild requested, force full sync first
    if (rebuild) {
      await sendSlackReply(
        { botTokenParam: BOT_TOKEN_PARAM },
        {
          channel: slackContext.channel_id,
          text: '🔄 Rebuilding Memory from CodeCommit...',
          thread_ts: slackContext.thread_ts,
        }
      );

      const syncResult = await invokeSyncAll(syncConfig, {
        operation: 'sync_all',
        actorId: slackContext.user_id,
        forceFullSync: true,
      });

      log('info', 'Rebuild sync completed', {
        event_id: eventId,
        success: syncResult.success,
        items_synced: syncResult.itemsSynced,
      });
    }

    // If repair requested, first get health report to find missing items
    if (repair) {
      // Get health report first
      const healthResult = await invokeHealthCheck(syncConfig, {
        operation: 'health_check',
        actorId: slackContext.user_id,
      });

      if (!healthResult.success || !healthResult.healthReport) {
        await sendSlackReply(
          { botTokenParam: BOT_TOKEN_PARAM },
          {
            channel: slackContext.channel_id,
            text: formatErrorReply('Failed to get health report for repair'),
            thread_ts: slackContext.thread_ts,
          }
        );
        await markFailed(idempotencyConfig, eventId, 'Health check failed');
        return;
      }

      const missingIds = healthResult.healthReport.missingInMemory;
      if (missingIds.length === 0) {
        await sendSlackReply(
          { botTokenParam: BOT_TOKEN_PARAM },
          {
            channel: slackContext.channel_id,
            text: '✅ Nothing to repair - Memory is in sync',
            thread_ts: slackContext.thread_ts,
          }
        );
        await markCompleted(idempotencyConfig, eventId);
        return;
      }

      await sendSlackReply(
        { botTokenParam: BOT_TOKEN_PARAM },
        {
          channel: slackContext.channel_id,
          text: `🔧 Repairing ${missingIds.length} missing item${missingIds.length > 1 ? 's' : ''}...`,
          thread_ts: slackContext.thread_ts,
        }
      );

      const repairResult = await invokeRepair(syncConfig, {
        operation: 'repair',
        actorId: slackContext.user_id,
        missingIds,
      });

      log('info', 'Repair completed', {
        event_id: eventId,
        success: repairResult.success,
        items_synced: repairResult.itemsSynced,
      });
    }

    // Invoke classifier with health_check operation
    const result = await invokeHealthCheck(syncConfig, {
      operation: 'health_check',
      actorId: slackContext.user_id,
    });

    // Format and send Slack reply
    let replyText: string;
    if (result.success && result.healthReport) {
      replyText = formatHealthReportForSlack(result.healthReport);
      if (rebuild) {
        replyText = '✅ Memory rebuilt successfully\n\n' + replyText;
      } else if (repair) {
        replyText = '✅ Repair completed\n\n' + replyText;
      }
    } else {
      replyText = `❌ ${commandType} failed\nError: ${result.error || 'Unknown error'}`;
    }

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: replyText,
        thread_ts: slackContext.thread_ts,
      }
    );

    // Create receipt for health check operation
    const receipt = createReceipt(
      eventId,
      slackContext,
      'health' as Classification, // Extended classification for health
      1.0,
      [{ type: 'health_check', status: result.success ? 'success' : 'failure', details: result.healthReport ? { ...result.healthReport } : { error: result.error } }],
      [],
      null,
      result.success && result.healthReport
        ? `Health check: ${result.healthReport.inSync ? 'In sync' : 'Out of sync'} (CC: ${result.healthReport.codecommitCount}, Mem: ${result.healthReport.memoryCount})`
        : `Health check failed: ${result.error}`,
      { healthReport: result.healthReport ? { ...result.healthReport } : undefined }
    );

    await appendReceipt(knowledgeConfig, receipt);

    if (result.success) {
      await markCompleted(idempotencyConfig, eventId);
      log('info', 'Health command completed', {
        event_id: eventId,
        in_sync: result.healthReport?.inSync,
        codecommit_count: result.healthReport?.codecommitCount,
        memory_count: result.healthReport?.memoryCount,
      });
    } else {
      await markFailed(idempotencyConfig, eventId, result.error || 'Health check failed');
      log('warn', 'Health command failed', {
        event_id: eventId,
        error: result.error,
      });
    }

  } catch (error) {
    log('error', 'Health command error', {
      event_id: eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Health check failed. Please try again.'),
        thread_ts: slackContext.thread_ts,
      }
    );

    await markFailed(idempotencyConfig, eventId, error instanceof Error ? error.message : 'Health check failed');
    throw error;
  }
}

/**
 * Handle reclassification request
 * 
 * Re-processes the original message with the new classification.
 * For tasks, this sends to OmniFocus. For other types, creates new file.
 */
async function handleReclassification(
  eventId: string,
  slackContext: SlackContext,
  priorReceipt: Awaited<ReturnType<typeof getFixableReceipt>>,
  targetClassification: Classification
): Promise<void> {
  if (!priorReceipt) return;

  log('info', 'Processing reclassification', {
    event_id: eventId,
    from: priorReceipt.classification,
    to: targetClassification,
  });

  // Get the original file content to extract the message
  const filePath = priorReceipt.files[0];
  const fileContent = await readFile(knowledgeConfig, filePath);
  
  if (!fileContent) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Could not read original entry'),
        thread_ts: slackContext.thread_ts,
      }
    );
    await markFailed(idempotencyConfig, eventId, 'Could not read original entry');
    return;
  }

  // Extract the original message
  const originalMessage = extractOriginalMessage(fileContent, filePath);
  
  log('info', 'Extracted original message for reclassification', {
    event_id: eventId,
    original_message: originalMessage.substring(0, 100),
  });

  // Re-invoke the classifier with the original message, forcing the classification
  const systemPrompt = await getSystemPrompt();
  const agentResult = await invokeAgentRuntime(agentConfig, {
    prompt: `Classify this as "${targetClassification}": ${originalMessage}`,
    system_prompt: systemPrompt.content,
    session_id: `${slackContext.channel_id}#${slackContext.user_id}`,
    user_id: slackContext.user_id,
  });

  if (!agentResult.success || !agentResult.actionPlan) {
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Failed to reclassify'),
        thread_ts: slackContext.thread_ts,
      }
    );
    await markFailed(idempotencyConfig, eventId, 'Reclassification failed');
    return;
  }

  // Override classification with user's choice
  const actionPlan = {
    ...agentResult.actionPlan,
    classification: targetClassification,
    confidence: 1.0, // User confirmed
  };

  // For non-inbox reclassifications, delete the old file first
  // (inbox entries are append-only, so we leave them)
  if (priorReceipt.classification !== 'inbox' && targetClassification !== priorReceipt.classification) {
    try {
      await deleteFile(
        knowledgeConfig,
        filePath,
        `Reclassify: ${priorReceipt.classification} → ${targetClassification}`
      );
      log('info', 'Deleted old file for reclassification', {
        event_id: eventId,
        deleted_file: filePath,
      });

      // Sync delete to Memory (fire-and-forget)
      // Validates: Requirements 3.1, 3.2
      if (AGENT_RUNTIME_ARN) {
        // Extract sb_id from the deleted file path
        // Pattern: <folder>/<date>__<slug>__<sb_id>.md
        const sbIdMatch = filePath.match(/sb-[a-f0-9]{7}/);
        if (sbIdMatch) {
          const sbId = sbIdMatch[0];
          await invokeDeleteItem(syncConfig, {
            operation: 'delete_item',
            actorId: slackContext.user_id,
            sbId,
          });
          log('info', 'Delete item sync invoked', {
            event_id: eventId,
            sb_id: sbId,
          });
        }
      }
    } catch (error) {
      log('warn', 'Failed to delete old file during reclassification', {
        event_id: eventId,
        file: filePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Continue anyway - the new file will still be created
    }
  }

  // Execute with the new classification
  await executeAndFinalize(eventId, slackContext, actionPlan, systemPrompt);

  log('info', 'Reclassification completed', {
    event_id: eventId,
    from: priorReceipt.classification,
    to: targetClassification,
  });
}

/**
 * Handle clarification response
 */
async function handleClarificationResponse(
  eventId: string,
  slackContext: SlackContext,
  responseText: string,
  context: Awaited<ReturnType<typeof getContext>>
): Promise<void> {
  if (!context) return;

  log('info', 'Processing clarification response', { event_id: eventId });

  // Check if response is a reclassify command
  const reclassifyMatch = responseText.match(/^reclassify:\s*(\w+)$/i);
  let classification: Classification;

  if (reclassifyMatch) {
    classification = reclassifyMatch[1].toLowerCase() as Classification;
  } else {
    // Try to match response to classification options
    const validClassifications: Classification[] = ['inbox', 'idea', 'decision', 'project', 'task'];
    const matchedClassification = validClassifications.find(
      c => responseText.toLowerCase().includes(c)
    );
    classification = matchedClassification || 'inbox';
  }

  // Clear conversation context
  await deleteContext(conversationConfig, slackContext.channel_id, slackContext.user_id);

  // Re-process with forced classification
  const systemPrompt = await getSystemPrompt();
  const agentResult = await invokeAgentRuntime(agentConfig, {
    prompt: `Classify this as "${classification}": ${context.original_message}`,
    system_prompt: systemPrompt.content,
    session_id: `${slackContext.channel_id}#${slackContext.user_id}`,
    user_id: slackContext.user_id,
  });

  if (!agentResult.success || !agentResult.actionPlan) {
    throw new Error(agentResult.error || 'AgentCore invocation failed');
  }

  // Override classification with user's choice
  const actionPlan = {
    ...agentResult.actionPlan,
    classification,
    confidence: 1.0, // User confirmed
  };

  await executeAndFinalize(eventId, slackContext, actionPlan, systemPrompt);
}

/**
 * Handle low confidence - ask for clarification
 */
async function handleLowConfidence(
  eventId: string,
  slackContext: SlackContext,
  originalMessage: string,
  actionPlan: ActionPlan
): Promise<void> {
  log('info', 'Low confidence, asking clarification', {
    event_id: eventId,
    confidence: actionPlan.confidence,
  });

  const classification = actionPlan.classification || 'inbox';

  // Store conversation context
  await setContext(conversationConfig, slackContext.channel_id, slackContext.user_id, {
    original_event_id: eventId,
    original_message: originalMessage,
    original_classification: classification,
    original_confidence: actionPlan.confidence,
    clarification_asked: generateClarificationPrompt(classification, actionPlan.confidence),
  });

  // Send clarification request
  const clarificationText = formatClarificationReply(
    "I'm not sure how to classify this. Is it:",
    ['inbox', 'idea', 'decision', 'project', 'task']
  );

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: clarificationText,
      thread_ts: slackContext.thread_ts,
    }
  );

  // Create receipt for clarification
  const receipt = createReceipt(
    eventId,
    slackContext,
    'clarify',
    actionPlan.confidence,
    [{ type: 'slack_reply', status: 'success', details: { type: 'clarification' } }],
    [],
    null,
    'Clarification requested'
  );

  await appendReceipt(knowledgeConfig, receipt);
  await markCompleted(idempotencyConfig, eventId);
}

/**
 * Handle validation failure
 */
async function handleValidationFailure(
  eventId: string,
  slackContext: SlackContext,
  errors: string[]
): Promise<void> {
  log('warn', 'Action plan validation failed', { event_id: eventId, errors });

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: formatErrorReply('Invalid response from classifier', errors),
      thread_ts: slackContext.thread_ts,
    }
  );

  // Create failure receipt
  const receipt = createReceipt(
    eventId,
    slackContext,
    'inbox', // Default
    0,
    [],
    [],
    null,
    'Validation failed',
    { validationErrors: errors }
  );

  await appendReceipt(knowledgeConfig, receipt);
  await markFailed(idempotencyConfig, eventId, `Validation failed: ${errors.join(', ')}`);
}

/**
 * Detect if a query is asking about projects by status
 * Returns the status being queried, or null if not a status query
 */
function detectProjectStatusQuery(queryText: string): ProjectStatus | null {
  const text = queryText.toLowerCase();
  
  // Patterns for status queries
  const patterns: Array<{ pattern: RegExp; status: ProjectStatus }> = [
    { pattern: /(?:show|list|what|which).*(?:active|current)\s*projects?/i, status: 'active' },
    { pattern: /(?:show|list|what|which).*(?:on-hold|on hold|paused)\s*projects?/i, status: 'on-hold' },
    { pattern: /(?:show|list|what|which).*(?:complete|completed|done|finished)\s*projects?/i, status: 'complete' },
    { pattern: /(?:show|list|what|which).*(?:cancelled|canceled|dropped)\s*projects?/i, status: 'cancelled' },
    { pattern: /projects?\s+(?:that\s+)?(?:are\s+)?active/i, status: 'active' },
    { pattern: /projects?\s+(?:that\s+)?(?:are\s+)?(?:on-hold|on hold|paused)/i, status: 'on-hold' },
    { pattern: /projects?\s+(?:that\s+)?(?:are\s+)?(?:complete|completed|done)/i, status: 'complete' },
    { pattern: /projects?\s+(?:that\s+)?(?:are\s+)?(?:cancelled|canceled)/i, status: 'cancelled' },
  ];
  
  for (const { pattern, status } of patterns) {
    if (pattern.test(text)) {
      return status;
    }
  }
  
  return null;
}

/**
 * Handle project status query
 */
async function handleProjectStatusQuery(
  eventId: string,
  slackContext: SlackContext,
  status: ProjectStatus,
  actionPlan: ActionPlan
): Promise<void> {
  log('info', 'Processing project status query', {
    event_id: eventId,
    status,
  });

  try {
    // Search the knowledge base for project files
    const searchConfig: KnowledgeSearchConfig = {
      repositoryName: REPOSITORY_NAME,
      branchName: 'main',
      maxFilesToSearch: 50,
      maxExcerptLength: 500,
    };

    const { CodeCommitClient } = await import('@aws-sdk/client-codecommit');
    const codecommitClient = new CodeCommitClient({ region: AWS_REGION });
    
    const searchResult = await searchKnowledgeBase(codecommitClient, searchConfig);

    // Filter projects by status
    const queryResult = queryProjectsByStatus(searchResult.files, status);

    // Format response
    const responseText = formatProjectQueryForSlack(queryResult, status);

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: responseText,
        thread_ts: slackContext.thread_ts,
      }
    );

    // Create receipt
    const receipt = createReceipt(
      eventId,
      slackContext,
      'query',
      actionPlan.intent_confidence,
      [{ type: 'slack_reply', status: 'success', details: { type: 'project_status_query' } }],
      queryResult.projects.map(p => p.path),
      null,
      `Project status query: ${status}`,
      {
        queryStatus: status,
        projectsFound: queryResult.totalCount,
      }
    );

    await appendReceipt(knowledgeConfig, receipt);
    await markCompleted(idempotencyConfig, eventId);

    log('info', 'Project status query completed', {
      event_id: eventId,
      status,
      projects_found: queryResult.totalCount,
    });

  } catch (error) {
    log('error', 'Project status query failed', {
      event_id: eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Failed to query projects. Please try again.'),
        thread_ts: slackContext.thread_ts,
      }
    );

    await markFailed(idempotencyConfig, eventId, error instanceof Error ? error.message : 'Query failed');
    throw error;
  }
}

/**
 * Handle query intent (Phase 2)
 * 
 * Validates: Requirements 53.2, 53.3, 54, 55, 56
 */
async function handleQueryIntent(
  eventId: string,
  slackContext: SlackContext,
  queryText: string,
  actionPlan: ActionPlan,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  log('info', 'Processing query intent', {
    event_id: eventId,
    intent_confidence: actionPlan.intent_confidence,
  });

  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  try {
    // If the classifier already provided a query_response (e.g., for help requests),
    // use it directly without searching the knowledge base
    if (actionPlan.query_response && actionPlan.cited_files?.length === 0) {
      log('info', 'Using classifier-provided query response (no search needed)', {
        event_id: eventId,
      });
      
      await sendSlackReply(
        { botTokenParam: BOT_TOKEN_PARAM },
        {
          channel: slackContext.channel_id,
          thread_ts: slackContext.thread_ts,
          text: actionPlan.query_response,
        }
      );

      const receipt = createReceipt(
        eventId,
        slackContext,
        'query' as Classification,
        actionPlan.intent_confidence,
        [], // actions
        [], // files
        null, // commitId
        'Help response', // summary
        { promptSha256: systemPrompt.metadata.sha256 }
      );

      await appendReceipt(knowledgeConfig, receipt);
      await markCompleted(idempotencyConfig, eventId);
      return;
    }

    // Check if this is a project status query
    const statusQueryMatch = detectProjectStatusQuery(queryText);
    
    if (statusQueryMatch) {
      await handleProjectStatusQuery(eventId, slackContext, statusQueryMatch, actionPlan);
      return;
    }

    // Search the knowledge base
    const searchConfig: KnowledgeSearchConfig = {
      repositoryName: REPOSITORY_NAME,
      branchName: 'main',
      maxFilesToSearch: 50,
      maxExcerptLength: 500,
    };

    const { CodeCommitClient } = await import('@aws-sdk/client-codecommit');
    const codecommitClient = new CodeCommitClient({ region: AWS_REGION });
    
    const searchResult = await searchKnowledgeBase(codecommitClient, searchConfig);

    // Process query against found files
    const queryResult = processQuery(queryText, searchResult.files);

    let responseText: string;
    let citedFiles: string[] = [];

    if (!queryResult.hasResults) {
      // No relevant results found
      responseText = generateNoResultsResponse(queryText);
    } else {
      // Use AgentCore to generate response from context
      const queryPrompt = buildQueryPrompt(queryText, queryResult.context, queryResult.citedFiles);
      
      const agentResult = await invokeAgentRuntime(agentConfig, {
        prompt: queryPrompt,
        system_prompt: systemPrompt.content,
        session_id: `${slackContext.channel_id}#${slackContext.user_id}`,
        user_id: slackContext.user_id,
      });

      if (agentResult.success && agentResult.actionPlan?.query_response) {
        responseText = agentResult.actionPlan.query_response;
        citedFiles = queryResult.citedFiles.map(f => f.path);
        
        // Validate citations (hallucination guard)
        const citationValidation = validateResponseCitations(responseText, queryResult.citedFiles);
        if (!citationValidation.valid) {
          log('warn', 'Query response citation warnings', {
            event_id: eventId,
            warnings: citationValidation.warnings,
          });
        }
      } else {
        // Fallback: use the excerpts directly
        responseText = queryResult.citedFiles
          .map(f => `From \`${f.path}\`:\n${f.excerpt}`)
          .join('\n\n');
        citedFiles = queryResult.citedFiles.map(f => f.path);
      }
    }

    // Format and send Slack reply
    const slackReply = formatQuerySlackReply(responseText, queryResult.citedFiles);
    
    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: slackReply,
        thread_ts: slackContext.thread_ts,
      }
    );

    // Create query receipt (hash query for PII protection)
    const queryHash = createHash('sha256').update(queryText).digest('hex').substring(0, 16);
    
    const receipt = createReceipt(
      eventId,
      slackContext,
      'query', // ExtendedClassification for Phase 2
      actionPlan.intent_confidence,
      [{ type: 'slack_reply', status: 'success', details: { type: 'query_response' } }],
      citedFiles,
      null, // No commit for queries
      `Query processed: ${queryHash}`,
      {
        queryHash,
        filesSearched: searchResult.totalFilesSearched,
        filesCited: citedFiles.length,
      }
    );

    await appendReceipt(knowledgeConfig, receipt);
    await markCompleted(idempotencyConfig, eventId);

    log('info', 'Query completed', {
      event_id: eventId,
      files_searched: searchResult.totalFilesSearched,
      files_cited: citedFiles.length,
    });

  } catch (error) {
    log('error', 'Query processing failed', {
      event_id: eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Failed to search knowledge base. Please try again.'),
        thread_ts: slackContext.thread_ts,
      }
    );

    await markFailed(idempotencyConfig, eventId, error instanceof Error ? error.message : 'Query failed');
    throw error;
  }
}

/**
 * Handle status update intent
 * 
 * Validates: Requirements 3.3, 3.5, 4.1, 8.1, 8.2, 8.3
 */
async function handleStatusUpdate(
  eventId: string,
  slackContext: SlackContext,
  actionPlan: ActionPlan
): Promise<void> {
  log('info', 'Processing status update intent', {
    event_id: eventId,
    project_reference: actionPlan.status_update?.project_reference,
    target_status: actionPlan.status_update?.target_status,
  });

  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  const statusUpdate = actionPlan.status_update!;

  try {
    // First check if LLM already matched a project via Memory context (linked_items)
    // This lets the LLM do what it does best - inferring links from context
    let matchResult: Awaited<ReturnType<typeof findMatchingProject>>;
    
    const linkedProject = actionPlan.linked_items?.find(item => 
      item.sb_id && item.title && (item.confidence ?? 0) >= 0.5
    );
    
    if (linkedProject) {
      // LLM already found the project - trust it
      log('info', 'Using linked_items for status update (LLM matched from Memory)', {
        event_id: eventId,
        sb_id: linkedProject.sb_id,
        title: linkedProject.title,
        confidence: linkedProject.confidence,
      });
      
      // Find the project path by sb_id
      const { CodeCommitClient, GetFolderCommand, GetFileCommand } = await import('@aws-sdk/client-codecommit');
      const codecommit = new CodeCommitClient({ region: AWS_REGION });
      
      const folderResponse = await codecommit.send(new GetFolderCommand({
        repositoryName: REPOSITORY_NAME,
        commitSpecifier: 'main',
        folderPath: '30-projects',
      }));
      
      const projectFile = folderResponse.files?.find(f => 
        f.absolutePath?.includes(linkedProject.sb_id)
      );
      
      if (projectFile?.absolutePath) {
        matchResult = {
          bestMatch: {
            sbId: linkedProject.sb_id,
            title: linkedProject.title,
            path: projectFile.absolutePath,
            confidence: linkedProject.confidence ?? 0.9,
          },
          candidates: [],
          searchedCount: 1,
        };
      } else {
        // Fallback to fuzzy search if file not found
        matchResult = await findMatchingProject(
          projectMatcherConfig,
          statusUpdate.project_reference
        );
      }
    } else {
      // No linked_items - fall back to fuzzy search
      matchResult = await findMatchingProject(
        projectMatcherConfig,
        statusUpdate.project_reference
      );
    }

    log('info', 'Project match result for status update', {
      event_id: eventId,
      searched_count: matchResult.searchedCount,
      best_match: matchResult.bestMatch?.sbId,
      best_confidence: matchResult.bestMatch?.confidence,
    });

    // Check if we have a confident match (>= 0.7 for auto-update)
    if (!matchResult.bestMatch || matchResult.bestMatch.confidence < projectMatcherConfig.autoLinkConfidence) {
      // No confident match found
      const errorMessage = matchResult.bestMatch
        ? `Found "${matchResult.bestMatch.title}" but confidence too low (${(matchResult.bestMatch.confidence * 100).toFixed(0)}%). Please be more specific.`
        : `Could not find a project matching "${statusUpdate.project_reference}"`;

      await sendSlackReply(
        { botTokenParam: BOT_TOKEN_PARAM },
        {
          channel: slackContext.channel_id,
          text: formatErrorReply(errorMessage),
          thread_ts: slackContext.thread_ts,
        }
      );

      await markFailed(idempotencyConfig, eventId, errorMessage);
      return;
    }

    // Update the project status
    const updateResult = await updateProjectStatus(
      knowledgeConfig,
      matchResult.bestMatch.path,
      statusUpdate.target_status,
      matchResult.bestMatch.title
    );

    if (!updateResult.success) {
      await sendSlackReply(
        { botTokenParam: BOT_TOKEN_PARAM },
        {
          channel: slackContext.channel_id,
          text: formatErrorReply(updateResult.error || 'Failed to update project status'),
          thread_ts: slackContext.thread_ts,
        }
      );

      await markFailed(idempotencyConfig, eventId, updateResult.error || 'Status update failed');
      return;
    }

    // Send confirmation - different message if status was already set
    const alreadySet = updateResult.previousStatus === updateResult.newStatus;
    const confirmationText = alreadySet
      ? `${matchResult.bestMatch.title} (${matchResult.bestMatch.sbId}) is already ${statusUpdate.target_status}`
      : `Updated ${matchResult.bestMatch.title} (${matchResult.bestMatch.sbId}) status to ${statusUpdate.target_status}`;

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: confirmationText,
        thread_ts: slackContext.thread_ts,
      }
    );

    // Create receipt for status update
    const receipt = createReceipt(
      eventId,
      slackContext,
      'status_update' as Classification, // Extended classification
      actionPlan.intent_confidence,
      [
        { type: 'commit', status: 'success', details: { commitId: updateResult.commitId } },
        { type: 'slack_reply', status: 'success', details: { type: 'status_confirmation' } },
      ],
      [matchResult.bestMatch.path],
      updateResult.commitId || null,
      confirmationText,
      {
        projectSbId: matchResult.bestMatch.sbId,
        previousStatus: updateResult.previousStatus,
        newStatus: updateResult.newStatus,
      }
    );

    await appendReceipt(knowledgeConfig, receipt);

    // Sync the updated item to Memory after successful commit
    // Use invokeSyncItem for the specific file we just updated
    // Pass commitId to update the sync marker after successful sync
    if (AGENT_RUNTIME_ARN && updateResult.commitId && updateResult.updatedContent) {
      try {
        await invokeSyncItem(syncConfig, {
          operation: 'sync_item',
          actorId: slackContext.user_id,
          itemPath: matchResult.bestMatch.path,
          itemContent: updateResult.updatedContent,
          commitId: updateResult.commitId,
        });
        log('info', 'Status update item synced to Memory', { 
          event_id: eventId, 
          item_path: matchResult.bestMatch.path,
          commit_id: updateResult.commitId,
        });
      } catch (err) {
        log('warn', 'Status update sync failed', { event_id: eventId, error: err instanceof Error ? err.message : 'Unknown' });
      }
    }

    await markCompleted(idempotencyConfig, eventId, updateResult.commitId);

    log('info', 'Status update completed', {
      event_id: eventId,
      project_sb_id: matchResult.bestMatch.sbId,
      previous_status: updateResult.previousStatus,
      new_status: updateResult.newStatus,
      commit_id: updateResult.commitId,
    });

  } catch (error) {
    log('error', 'Status update failed', {
      event_id: eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    await sendSlackReply(
      { botTokenParam: BOT_TOKEN_PARAM },
      {
        channel: slackContext.channel_id,
        text: formatErrorReply('Failed to update project status. Please try again.'),
        thread_ts: slackContext.thread_ts,
      }
    );

    await markFailed(idempotencyConfig, eventId, error instanceof Error ? error.message : 'Status update failed');
    throw error;
  }
}

/**
 * Execute action plan and finalize
 */
async function executeAndFinalize(
  eventId: string,
  slackContext: SlackContext,
  actionPlan: ActionPlan,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  // Project linking from Memory context: Check linked_items for tasks, ideas, and decisions
  const linkableTypes = ['task', 'idea', 'decision'];
  if (linkableTypes.includes(actionPlan.classification || '') && !actionPlan.linked_project && actionPlan.linked_items?.length) {
    // Find project in linked_items
    const linkedProject = actionPlan.linked_items.find(item => 
      item.sb_id && item.title && (item.confidence ?? 0) >= 0.5
    );
    if (linkedProject) {
      actionPlan.linked_project = {
        sb_id: linkedProject.sb_id,
        title: linkedProject.title,
        confidence: linkedProject.confidence ?? 0.8,
      };
      log('info', `${actionPlan.classification} linked to project from Memory context`, {
        event_id: eventId,
        project_sb_id: linkedProject.sb_id,
        project_title: linkedProject.title,
      });
    }
  }

  // Task-project linking: Fallback to project_reference search if no linked_project yet
  if (actionPlan.classification === 'task' && !actionPlan.linked_project && actionPlan.project_reference) {
    log('info', 'Task has project reference, searching for match', {
      event_id: eventId,
      project_reference: actionPlan.project_reference,
    });

    try {
      const matchResult = await findMatchingProject(
        projectMatcherConfig,
        actionPlan.project_reference
      );

      log('info', 'Project match result', {
        event_id: eventId,
        searched_count: matchResult.searchedCount,
        best_match: matchResult.bestMatch?.sbId,
        best_confidence: matchResult.bestMatch?.confidence,
        candidates_count: matchResult.candidates.length,
      });

      if (matchResult.bestMatch && matchResult.bestMatch.confidence >= projectMatcherConfig.autoLinkConfidence) {
        // Auto-link: single clear match
        actionPlan.linked_project = {
          sb_id: matchResult.bestMatch.sbId,
          title: matchResult.bestMatch.title,
          confidence: matchResult.bestMatch.confidence,
        };
      } else if (matchResult.candidates.length > 1) {
        // Multiple candidates: store for potential clarification (future enhancement)
        // For now, just use the best candidate if above min threshold
        if (matchResult.candidates[0] && matchResult.candidates[0].confidence >= projectMatcherConfig.minConfidence) {
          actionPlan.linked_project = {
            sb_id: matchResult.candidates[0].sbId,
            title: matchResult.candidates[0].title,
            confidence: matchResult.candidates[0].confidence,
          };
        }
      }
    } catch (error) {
      // Log but don't fail - project linking is optional
      log('warn', 'Project matching failed', {
        event_id: eventId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Build executor config
  const executorConfig: ExecutorConfig = {
    knowledgeStore: knowledgeConfig,
    idempotency: idempotencyConfig,
    sesRegion: AWS_REGION,
    slackBotTokenParam: BOT_TOKEN_PARAM,
    mailDropParam: MAILDROP_PARAM,
    emailMode: EMAIL_MODE === 'log-only' ? 'log' : 'live',
    senderEmail: SES_FROM_EMAIL,
  };

  // Execute the action plan
  const result = await executeActionPlan(
    executorConfig,
    eventId,
    actionPlan,
    slackContext,
    { commitId: systemPrompt.metadata.commitId, sha256: systemPrompt.metadata.sha256, loadedAt: new Date().toISOString() }
  );

  // Task logging: If task was linked to a project, log it in the project file
  if (result.success && actionPlan.classification === 'task' && actionPlan.linked_project) {
    try {
      const taskTitle = actionPlan.task_details?.title || actionPlan.title || 'Untitled task';
      const today = new Date().toISOString().split('T')[0];
      
      // Find the project path from the match
      const matchResult = await findMatchingProject(
        projectMatcherConfig,
        actionPlan.linked_project.title
      );
      
      if (matchResult.bestMatch) {
        const logResult = await appendTaskLog(
          knowledgeConfig,
          matchResult.bestMatch.path,
          { date: today, title: taskTitle }
        );
        
        if (logResult.success) {
          log('info', 'Task logged to project', {
            event_id: eventId,
            project_sb_id: actionPlan.linked_project.sb_id,
            task_title: taskTitle,
            commit_id: logResult.commitId,
          });
        } else {
          log('warn', 'Failed to log task to project', {
            event_id: eventId,
            project_sb_id: actionPlan.linked_project.sb_id,
            error: logResult.error,
          });
        }
      }
    } catch (error) {
      // Log but don't fail - task logging is supplementary
      log('warn', 'Task logging failed', {
        event_id: eventId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Reference logging: If idea/decision was linked to a project, add to project's References
  if (result.success && (actionPlan.classification === 'idea' || actionPlan.classification === 'decision') && actionPlan.linked_project) {
    try {
      // Get the sb_id from the created file path
      const createdFile = result.filesModified?.[0];
      const sbIdMatch = createdFile?.match(/sb-[a-f0-9]{7}/);
      const sbId = sbIdMatch?.[0];
      
      if (sbId) {
        // Find project by sb_id from linked_project (trust the LLM's match from Memory)
        const { CodeCommitClient, GetFolderCommand } = await import('@aws-sdk/client-codecommit');
        const codecommit = new CodeCommitClient({ region: AWS_REGION });
        
        const folderResponse = await codecommit.send(new GetFolderCommand({
          repositoryName: REPOSITORY_NAME,
          commitSpecifier: 'main',
          folderPath: '30-projects',
        }));
        
        const projectFile = folderResponse.files?.find(f => 
          f.absolutePath?.includes(actionPlan.linked_project!.sb_id)
        );
        
        if (projectFile?.absolutePath) {
          const logResult = await appendReferenceLog(
            knowledgeConfig,
            projectFile.absolutePath,
            { 
              sbId, 
              title: actionPlan.title || 'Untitled', 
              type: actionPlan.classification as 'idea' | 'decision'
            }
          );
          
          if (logResult.success) {
            log('info', 'Reference logged to project', {
              event_id: eventId,
              project_sb_id: actionPlan.linked_project.sb_id,
              reference_sb_id: sbId,
              reference_type: actionPlan.classification,
              commit_id: logResult.commitId,
            });
          } else {
            log('warn', 'Failed to log reference to project', {
              event_id: eventId,
              project_sb_id: actionPlan.linked_project.sb_id,
              error: logResult.error,
            });
          }
        } else {
          log('warn', 'Project file not found for reference logging', {
            event_id: eventId,
            project_sb_id: actionPlan.linked_project.sb_id,
          });
        }
      }
    } catch (error) {
      log('warn', 'Reference logging failed', {
        event_id: eventId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (result.success) {
    // Notify classifier of commit for background sync to Memory
    // This is fire-and-forget - doesn't block the response
    // The classifier handles Memory sync internally
    // Validates: Requirements 1.1, 1.5
    if (AGENT_RUNTIME_ARN && result.filesModified?.length && result.commitId && result.fileContents?.length) {
      // Fire-and-forget: invokeSyncItem doesn't throw, just logs errors
      invokeSyncItem(syncConfig, {
        operation: 'sync_item',
        actorId: slackContext.user_id,
        itemPath: result.filesModified[0],
        itemContent: result.fileContents[0],
        commitId: result.commitId,
      });
      log('info', 'Post-commit sync initiated (non-blocking)', { 
        event_id: eventId, 
        file_path: result.filesModified[0],
      });
    }

    await markCompleted(idempotencyConfig, eventId, result.commitId, result.receiptCommitId);
    log('info', 'Processing completed', {
      event_id: eventId,
      classification: actionPlan.classification,
      commit_id: result.commitId,
      linked_project: actionPlan.linked_project?.sb_id,
    });
  } else {
    log('warn', 'Execution failed', {
      event_id: eventId,
      error: result.error,
    });
  }
}

// ============================================================================
// Multi-Item Message Handling
// ============================================================================

/**
 * Process result for a single item in a multi-item message
 */
interface ItemProcessingResult {
  index: number;
  success: boolean;
  classification: Classification | null;
  title: string;
  commitId?: string;
  filesModified?: string[];
  error?: string;
  linkedProject?: string; // Project title if task was linked
}

/**
 * Get emoji for classification type
 */
function getClassificationEmoji(classification: Classification | null): string {
  const emojis: Record<string, string> = {
    inbox: '📥',
    idea: '💡',
    decision: '✅',
    project: '📁',
    task: '✓',
  };
  return emojis[classification || 'inbox'] || '📝';
}

/**
 * Format consolidated confirmation message for multi-item processing
 * 
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */
function formatMultiItemConfirmation(results: ItemProcessingResult[]): string {
  const lines: string[] = [`Processed ${results.length} items:`];
  
  for (const result of results) {
    if (result.success) {
      const emoji = getClassificationEmoji(result.classification);
      const projectSuffix = result.linkedProject ? ` (${result.linkedProject})` : '';
      lines.push(`• ${emoji} ${result.title} → ${result.classification}${projectSuffix}`);
    } else {
      lines.push(`• ❌ ${result.title} → Failed: ${result.error}`);
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  const failCount = results.length - successCount;
  
  if (failCount > 0) {
    lines.push(`\n${successCount} succeeded, ${failCount} failed`);
  }
  
  return lines.join('\n');
}

/**
 * Create receipt for multi-item message processing
 * 
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
 */
function createMultiItemReceipt(
  eventId: string,
  slackContext: SlackContext,
  results: ItemProcessingResult[],
  allFilesModified: string[]
): ReturnType<typeof createReceipt> {
  const successCount = results.filter(r => r.success).length;
  const failCount = results.length - successCount;
  
  // Build summary
  const classificationCounts: Record<string, number> = {};
  for (const result of results) {
    if (result.success && result.classification) {
      classificationCounts[result.classification] = (classificationCounts[result.classification] || 0) + 1;
    }
  }
  
  const summaryParts = Object.entries(classificationCounts)
    .map(([cls, count]) => `${count} ${cls}${count > 1 ? 's' : ''}`)
    .join(', ');
  
  const summary = `Processed ${results.length} items: ${summaryParts}${failCount > 0 ? `, ${failCount} failed` : ''}`;
  
  // Build multi-item metadata
  const multiItemMeta = {
    item_count: results.length,
    items: results.map(r => ({
      index: r.index,
      classification: r.classification,
      title: r.title,
      success: r.success,
      error: r.error,
    })),
  };
  
  return createReceipt(
    eventId,
    slackContext,
    'multi-item' as Classification, // Extended classification
    0.9, // Confidence for multi-item
    results.map(r => ({
      type: r.classification === 'task' ? 'email' : 'commit',
      status: r.success ? 'success' : 'failure',
      details: r.success ? { commitId: r.commitId } : { error: r.error },
    })),
    allFilesModified,
    null, // No single commit ID for multi-item
    summary,
    { multi_item: multiItemMeta }
  );
}

/**
 * Process a single item from a multi-item message
 */
async function processSingleItem(
  eventId: string,
  slackContext: SlackContext,
  actionPlan: ActionPlan,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } },
  itemIndex: number
): Promise<{ commitId?: string; filesModified?: string[]; linkedProject?: string; generatedSbId?: string }> {
  log('info', 'Processing multi-item item', {
    event_id: eventId,
    item_index: itemIndex,
    classification: actionPlan.classification,
    title: actionPlan.title,
    project_reference: actionPlan.project_reference,
  });

  // Project linking from Memory context: Check linked_items for tasks, ideas, and decisions
  const linkableTypes = ['task', 'idea', 'decision'];
  if (linkableTypes.includes(actionPlan.classification || '') && !actionPlan.linked_project && actionPlan.linked_items?.length) {
    const linkedProject = actionPlan.linked_items.find(item => 
      item.sb_id && item.title && (item.confidence ?? 0) >= 0.5
    );
    if (linkedProject) {
      actionPlan.linked_project = {
        sb_id: linkedProject.sb_id,
        title: linkedProject.title,
        confidence: linkedProject.confidence ?? 0.8,
      };
      log('info', `Multi-item ${actionPlan.classification} linked to project from Memory context`, {
        event_id: eventId,
        item_index: itemIndex,
        project_sb_id: linkedProject.sb_id,
        project_title: linkedProject.title,
      });
    }
  }

  // Task-project linking: Fallback to project_reference search if no linked_project yet
  if (actionPlan.classification === 'task' && !actionPlan.linked_project && actionPlan.project_reference) {
    log('info', 'Multi-item task has project reference, searching for match', {
      event_id: eventId,
      item_index: itemIndex,
      project_reference: actionPlan.project_reference,
    });

    try {
      const matchResult = await findMatchingProject(
        projectMatcherConfig,
        actionPlan.project_reference
      );

      log('info', 'Project match result for multi-item task', {
        event_id: eventId,
        item_index: itemIndex,
        searched_count: matchResult.searchedCount,
        best_match: matchResult.bestMatch?.sbId,
        best_confidence: matchResult.bestMatch?.confidence,
      });

      if (matchResult.bestMatch && matchResult.bestMatch.confidence >= projectMatcherConfig.autoLinkConfidence) {
        actionPlan.linked_project = {
          sb_id: matchResult.bestMatch.sbId,
          title: matchResult.bestMatch.title,
          confidence: matchResult.bestMatch.confidence,
        };
      } else if (matchResult.candidates.length > 0 && matchResult.candidates[0].confidence >= projectMatcherConfig.minConfidence) {
        actionPlan.linked_project = {
          sb_id: matchResult.candidates[0].sbId,
          title: matchResult.candidates[0].title,
          confidence: matchResult.candidates[0].confidence,
        };
      }
    } catch (error) {
      log('warn', 'Project matching failed for multi-item task', {
        event_id: eventId,
        item_index: itemIndex,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Build executor config
  const executorConfig: ExecutorConfig = {
    knowledgeStore: knowledgeConfig,
    idempotency: idempotencyConfig,
    sesRegion: AWS_REGION,
    slackBotTokenParam: BOT_TOKEN_PARAM,
    mailDropParam: MAILDROP_PARAM,
    emailMode: EMAIL_MODE === 'log-only' ? 'log' : 'live',
    senderEmail: SES_FROM_EMAIL,
  };

  // Execute the action plan (without sending Slack reply - we'll send consolidated)
  const result = await executeActionPlan(
    executorConfig,
    `${eventId}-item-${itemIndex}`, // Unique ID for this item
    actionPlan,
    slackContext,
    { commitId: systemPrompt.metadata.commitId, sha256: systemPrompt.metadata.sha256, loadedAt: new Date().toISOString() },
    true // skipSlackReply flag
  );

  if (!result.success) {
    throw new Error(result.error || 'Item processing failed');
  }

  // Task logging: If task was linked to a project, log it in the project file
  if (result.success && actionPlan.classification === 'task' && actionPlan.linked_project) {
    try {
      const taskTitle = actionPlan.task_details?.title || actionPlan.title || 'Untitled task';
      const today = new Date().toISOString().split('T')[0];
      
      const matchResult = await findMatchingProject(
        projectMatcherConfig,
        actionPlan.linked_project.title
      );
      
      if (matchResult.bestMatch) {
        const logResult = await appendTaskLog(
          knowledgeConfig,
          matchResult.bestMatch.path,
          { date: today, title: taskTitle }
        );
        
        if (logResult.success) {
          log('info', 'Multi-item task logged to project', {
            event_id: eventId,
            item_index: itemIndex,
            project_sb_id: actionPlan.linked_project.sb_id,
            task_title: taskTitle,
            commit_id: logResult.commitId,
          });
        }
      }
    } catch (error) {
      log('warn', 'Multi-item task logging failed', {
        event_id: eventId,
        item_index: itemIndex,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Reference logging: If idea/decision was linked to a project, add to project's References
  if (result.success && (actionPlan.classification === 'idea' || actionPlan.classification === 'decision') && actionPlan.linked_project) {
    try {
      const createdFile = result.filesModified?.[0];
      const sbIdMatch = createdFile?.match(/sb-[a-f0-9]{7}/);
      const sbId = sbIdMatch?.[0];
      
      if (sbId) {
        // Find project by sb_id from linked_project (trust the LLM's match from Memory)
        const { CodeCommitClient, GetFolderCommand } = await import('@aws-sdk/client-codecommit');
        const codecommit = new CodeCommitClient({ region: AWS_REGION });
        
        const folderResponse = await codecommit.send(new GetFolderCommand({
          repositoryName: REPOSITORY_NAME,
          commitSpecifier: 'main',
          folderPath: '30-projects',
        }));
        
        const projectFile = folderResponse.files?.find(f => 
          f.absolutePath?.includes(actionPlan.linked_project!.sb_id)
        );
        
        if (projectFile?.absolutePath) {
          const logResult = await appendReferenceLog(
            knowledgeConfig,
            projectFile.absolutePath,
            { 
              sbId, 
              title: actionPlan.title || 'Untitled', 
              type: actionPlan.classification as 'idea' | 'decision'
            }
          );
          
          if (logResult.success) {
            log('info', 'Multi-item reference logged to project', {
              event_id: eventId,
              item_index: itemIndex,
              project_sb_id: actionPlan.linked_project.sb_id,
              reference_sb_id: sbId,
              commit_id: logResult.commitId,
            });
          }
        }
      }
    } catch (error) {
      log('warn', 'Multi-item reference logging failed', {
        event_id: eventId,
        item_index: itemIndex,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Notify classifier of commit for background sync (fire-and-forget)
  // Validates: Requirements 1.1, 1.5
  if (AGENT_RUNTIME_ARN && result.filesModified?.length && result.commitId && result.fileContents?.length) {
    invokeSyncItem(syncConfig, {
      operation: 'sync_item',
      actorId: slackContext.user_id,
      itemPath: result.filesModified[0],
      itemContent: result.fileContents[0],
      commitId: result.commitId,
    });
    log('info', 'Multi-item post-commit sync initiated (non-blocking)', { 
      event_id: eventId, 
      item_index: itemIndex,
      file_path: result.filesModified[0],
    });
  }

  return {
    commitId: result.commitId,
    filesModified: result.filesModified,
    linkedProject: actionPlan.linked_project?.title,
    generatedSbId: result.generatedSbId,
  };
}

/**
 * Handle multi-item validation failure
 */
async function handleMultiItemValidationFailure(
  eventId: string,
  slackContext: SlackContext,
  errors: Array<{ index: number; field: string; message: string }>
): Promise<void> {
  const errorMessages = errors.map(e => 
    e.index >= 0 ? `Item ${e.index + 1}: ${e.message}` : e.message
  );

  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: formatErrorReply('Invalid multi-item response', errorMessages),
      thread_ts: slackContext.thread_ts,
    }
  );

  await markFailed(idempotencyConfig, eventId, `Multi-item validation failed: ${errorMessages.join(', ')}`);
}

/**
 * Handle a multi-item message
 * 
 * Validates: Requirements 3.2, 4.1, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 9.1-9.5
 */
async function handleMultiItemMessage(
  eventId: string,
  slackContext: SlackContext,
  response: MultiItemResponse,
  systemPrompt: { content: string; metadata: { commitId: string; sha256: string } }
): Promise<void> {
  const results: ItemProcessingResult[] = [];
  const allFilesModified: string[] = [];
  
  log('info', 'Processing multi-item message', {
    event_id: eventId,
    item_count: response.items.length,
  });

  await updateExecutionState(idempotencyConfig, eventId, { status: 'EXECUTING' });

  // Validate all items first
  const validation = validateMultiItemResponse(response);
  if (!validation.valid) {
    log('warn', 'Multi-item validation failed', {
      event_id: eventId,
      errors: validation.errors,
    });
    await handleMultiItemValidationFailure(eventId, slackContext, validation.errors);
    return;
  }

  // Track generated sb_ids for cross-reference resolution
  // Maps placeholder sb_id (sb-xxxxxxx) or title to real generated sb_id
  const generatedSbIds: Map<string, string> = new Map();

  // Process each item sequentially (fail-forward)
  for (let i = 0; i < response.items.length; i++) {
    const actionPlan = response.items[i];
    
    // Resolve placeholder sb_ids in linked_items using previously generated sb_ids
    if (actionPlan.linked_items?.length) {
      for (const linkedItem of actionPlan.linked_items) {
        // Check if this linked_item references a placeholder or a title we've already processed
        if (linkedItem.sb_id === 'sb-xxxxxxx' || linkedItem.sb_id.startsWith('sb-xxxxxxx')) {
          // Try to find by title match
          const realSbId = generatedSbIds.get(linkedItem.title);
          if (realSbId) {
            log('info', 'Resolved placeholder sb_id in linked_items', {
              event_id: eventId,
              item_index: i,
              original_sb_id: linkedItem.sb_id,
              resolved_sb_id: realSbId,
              title: linkedItem.title,
            });
            linkedItem.sb_id = realSbId;
          }
        }
      }
    }
    
    try {
      const result = await processSingleItem(
        eventId,
        slackContext,
        actionPlan,
        systemPrompt,
        i
      );
      
      // Track generated sb_id for cross-reference resolution in subsequent items
      if (result.generatedSbId && actionPlan.title) {
        generatedSbIds.set(actionPlan.title, result.generatedSbId);
        log('info', 'Tracked generated sb_id for cross-reference', {
          event_id: eventId,
          item_index: i,
          title: actionPlan.title,
          sb_id: result.generatedSbId,
        });
      }
      
      results.push({
        index: i,
        success: true,
        classification: actionPlan.classification,
        title: actionPlan.title || `Item ${i + 1}`,
        commitId: result.commitId,
        filesModified: result.filesModified,
        linkedProject: result.linkedProject,
      });
      
      if (result.filesModified) {
        allFilesModified.push(...result.filesModified);
      }
    } catch (error) {
      log('warn', 'Item processing failed', {
        event_id: eventId,
        item_index: i,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      results.push({
        index: i,
        success: false,
        classification: actionPlan.classification,
        title: actionPlan.title || `Item ${i + 1}`,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Continue processing remaining items (fail-forward)
    }
  }

  // Send consolidated confirmation
  const confirmationText = formatMultiItemConfirmation(results);
  await sendSlackReply(
    { botTokenParam: BOT_TOKEN_PARAM },
    {
      channel: slackContext.channel_id,
      text: confirmationText,
      thread_ts: slackContext.thread_ts,
    }
  );

  // Create consolidated receipt
  const receipt = createMultiItemReceipt(
    eventId,
    slackContext,
    results,
    allFilesModified
  );
  await appendReceipt(knowledgeConfig, receipt);

  // Mark as completed if at least one item succeeded
  const anySuccess = results.some(r => r.success);
  if (anySuccess) {
    await markCompleted(idempotencyConfig, eventId);
    log('info', 'Multi-item processing completed', {
      event_id: eventId,
      total_items: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });
  } else {
    await markFailed(idempotencyConfig, eventId, 'All items failed to process');
    log('warn', 'Multi-item processing failed - all items failed', {
      event_id: eventId,
      total_items: results.length,
    });
  }
}

/**
 * Lambda handler for SQS events
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  log('info', 'Worker received event', {
    recordCount: event.Records.length,
  });

  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as SQSEventMessage;
      await processMessage(message);
    } catch (error) {
      log('error', 'Failed to process message', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
}
