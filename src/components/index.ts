/**
 * Components Index
 * 
 * Re-exports all component modules for easy importing.
 */

// Idempotency Guard
export {
  tryAcquireLock,
  updateExecutionState,
  markCompleted,
  markFailed,
  markPartialFailure,
  isProcessed,
  getExecutionState,
  getCompletedSteps,
  canRetry,
  type ExecutionStatus,
  type StepStatus,
  type ExecutionState,
  type CompletedSteps,
  type IdempotencyConfig,
} from './idempotency-guard';

// Knowledge Store
export {
  getLatestCommitId,
  readFile,
  writeFile,
  appendToFile,
  deleteFile,
  generateFilePath,
  generateSlug,
  createKnowledgeFile,
  type KnowledgeStoreConfig,
  type CommitResult,
  type FileContent,
} from './knowledge-store';

// Receipt Logger
export {
  createReceipt,
  serializeReceipt,
  parseReceipt,
  appendReceipt,
  findReceiptByEventId,
  findMostRecentReceipt,
  getAllReceipts,
  type Receipt,
  type ReceiptAction,
  type SlackContext,
} from './receipt-logger';

// System Prompt Loader
export {
  loadSystemPrompt,
  computePromptHash,
  validatePromptStructure,
  clearPromptCache,
  getCachedPrompt,
  type SystemPromptConfig,
  type SystemPromptMetadata,
  type SystemPrompt,
  type PromptValidationResult,
} from './system-prompt-loader';

// Action Plan
export {
  validateActionPlan,
  parseActionPlanFromLLM,
  createDefaultActionPlan,
  requiresClarification,
  hasHighConfidence,
  type ActionPlan,
  type FileOperation,
  type TaskDetails,
  type ValidationError,
  type ValidationResult,
  type Intent,
} from './action-plan';

// Action Executor
export {
  executeActionPlan,
  type ExecutorConfig,
  type ExecutionResult,
} from './action-executor';

// AgentCore Client
export {
  invokeAgentRuntime,
  shouldAskClarification,
  generateClarificationPrompt,
  MockAgentCoreClient,
  CONFIDENCE_THRESHOLDS,
  type AgentCoreConfig,
  type InvocationPayload,
  type InvocationResult,
} from './agentcore-client';

// Task Router
export {
  formatTaskEmail,
  sendTaskEmail,
  clearMailDropCache,
  type TaskEmail,
  type TaskRouterConfig,
  type TaskSendResult,
  type SlackSource,
} from './task-router';

// Slack Responder
export {
  formatConfirmationReply,
  formatClarificationReply,
  formatErrorReply,
  sendSlackReply,
  clearBotTokenCache,
  type SlackReply,
  type SlackResponderConfig,
  type SlackSendResult,
} from './slack-responder';

// Conversation Context
export {
  generateSessionId,
  parseSessionId,
  getContext,
  setContext,
  updateContextWithResponse,
  deleteContext,
  hasActiveContext,
  clearTTLCache,
  getCachedTTL,
  type ConversationContext,
  type ConversationStoreConfig,
} from './conversation-context';

// Fix Handler
export {
  parseFixCommand,
  isFixCommand,
  getFixableReceipt,
  applyFix,
  canApplyFix,
  detectReclassifyRequest,
  extractOriginalMessage,
  type FixCommand,
  type FixResult,
  type ReclassifyRequest,
} from './fix-handler';

// Markdown Templates
export {
  formatISODate,
  formatISOTime,
  sanitizeForMarkdown,
  generateInboxEntry,
  generateInboxHeader,
  generateIdeaNote,
  generateDecisionNote,
  generateProjectPage,
  generateContent,
  type TemplateOptions,
  type InboxEntry,
  type IdeaNote,
  type DecisionNote,
  type ProjectPage,
} from './markdown-templates';

// Knowledge Search (Phase 2)
export {
  searchKnowledgeBase,
  formatFilesAsContext,
  scoreFileRelevance,
  getTopRelevantFiles,
  extractDateFromPath,
  extractExcerpt,
  DEFAULT_SEARCH_CONFIG,
  type KnowledgeSearchConfig,
  type KnowledgeFile,
  type CitedFile,
  type KnowledgeSearchResult,
} from './knowledge-search';

// Query Handler (Phase 2)
export {
  processQuery,
  buildQueryPrompt,
  generateNoResultsResponse,
  formatCitationsForSlack,
  formatQuerySlackReply,
  validateResponseCitations,
  isLikelyQuery,
  DEFAULT_QUERY_CONFIG,
  type QueryConfig,
  type QueryResult,
} from './query-handler';

// Project Status Updater
export {
  parseFrontMatter,
  serializeFrontMatter,
  isValidProjectStatus,
  updateProjectStatus,
  type ProjectStatusUpdaterConfig,
  type StatusUpdateResult,
  type ParsedFrontMatter,
} from './project-status-updater';

// Task Logger
export {
  formatTaskLogEntry,
  ensureTasksSection,
  appendTaskToSection,
  appendTaskLog,
  formatReferenceEntry,
  ensureReferencesSection,
  ensureIdeasSection,
  ensureDecisionsSection,
  appendReferenceToSection,
  appendReferenceLog,
  type TaskLoggerConfig,
  type TaskLogEntry,
  type TaskLogResult,
  type ReferenceEntry,
} from './task-logger';

// Status Intent Detector
export {
  mapNaturalLanguageToStatus,
  detectStatusUpdateIntent,
  extractStatusUpdate,
  getTermsForStatus,
  getSupportedPatterns,
} from './status-intent-detector';

// Sync Invoker
export {
  invokeSyncItem,
  invokeDeleteItem,
  invokeSyncAll,
  invokeHealthCheck,
  invokeRepair,
  type SyncItemRequest,
  type DeleteItemRequest,
  type SyncAllRequest,
  type HealthCheckRequest,
  type SyncResponse,
  type HealthReport,
  type SyncInvokerConfig,
} from './sync-invoker';

// Filing Plan Validator
export {
  validateFilingPlan,
  parseFilingPlanFromLLM,
} from './filing-plan-validator';

// Filing Plan Path Validator
export {
  validateFilePath,
} from './filing-plan-path-validator';

// Content Integrator
export {
  parseMarkdownSections,
  serializeMarkdownSections,
  applyContentOperation,
  type MarkdownSection,
  type ParsedMarkdown,
  type ContentOperation,
  type ContentResult,
} from './content-integrator';

// FSI Updater
export {
  applyCreate as fsiApplyCreate,
  applyDelete as fsiApplyDelete,
  applyMove as fsiApplyMove,
  getIntermediateFolders,
  isFolderEmpty,
  rebuildFSIFromTree,
  type FSIFileMetadata,
} from './fsi-updater';

// FSI Memory Client
export {
  retrieveFSI,
  persistFSI,
  type FSIMemoryConfig,
} from './fsi-memory-client';

// Filing Executor
export {
  executeFilingPlan,
  type FilingExecutorConfig,
  type FilingExecutionResult,
  type FSIPersistCallback,
} from './filing-executor';

// Conversation Session Store
export {
  createSession,
  appendMessage,
  getActiveSession,
  markSessionFiled,
  markSessionDiscarded,
  generateDiscussionId,
  buildSessionId,
  type SessionStoreConfig,
} from './conversation-session-store';

// Draft Persistence
export {
  buildDraftPath,
  buildDraftContent,
  persistDraft,
  loadDraft,
  deleteDraft,
  listDrafts,
  generateSlug as generateDraftSlug,
  parseDraftContent,
} from './draft-persistence';

// Wikilink Injector
export {
  injectWikilinks,
  injectBacklinks,
} from './wikilink-injector';
