/**
 * Filing Executor — Execution engine for Filing Plan operations
 *
 * Dispatches on FilingPlan.action to perform create, append, update, delete,
 * and move operations against CodeCommit. Updates the Folder Structure Index
 * after each successful commit.
 *
 * Validates: Requirements 7.1–7.10, 11.1–11.4, 2.13, 2.14
 */

import {
  CodeCommitClient,
  GetBranchCommand,
  GetFileCommand,
  CreateCommitCommand,
  FileDoesNotExistException,
  ParentCommitIdOutdatedException,
} from '@aws-sdk/client-codecommit';
import type { FilingPlan } from '../types/filing-plan';
import type { FolderStructureIndex } from '../types/folder-structure-index';
import { applyContentOperation } from './content-integrator';
import { applyCreate, applyDelete, applyMove } from './fsi-updater';
import { injectWikilinks, injectBacklinks } from './wikilink-injector';
import { validateFilePath } from './filing-plan-path-validator';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Configuration for the filing executor.
 */
export interface FilingExecutorConfig {
  repositoryName: string;
  branchName: string;
  actorId: string;
}

/**
 * Result of executing a filing plan.
 */
export interface FilingExecutionResult {
  success: boolean;
  commitId?: string;
  warnings: string[];
  error?: string;
  confirmationRequired?: boolean;
}

/**
 * Callback for persisting the updated FSI after a successful commit.
 * The executor calls this after each commit so the caller can wire in
 * the actual AgentCore Memory persistence.
 */
export type FSIPersistCallback = (fsi: FolderStructureIndex) => Promise<void>;

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 3;
const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024; // 100 KB

// ─── CodeCommit helpers ──────────────────────────────────────────────────────

const codecommitClient = new CodeCommitClient({});

async function getLatestCommitId(config: FilingExecutorConfig): Promise<string> {
  const resp = await codecommitClient.send(
    new GetBranchCommand({
      repositoryName: config.repositoryName,
      branchName: config.branchName,
    })
  );
  return resp.branch?.commitId ?? '';
}

/**
 * Read a file from CodeCommit. Returns null if the file does not exist.
 */
async function readFileFromRepo(
  config: FilingExecutorConfig,
  filePath: string
): Promise<string | null> {
  try {
    const resp = await codecommitClient.send(
      new GetFileCommand({
        repositoryName: config.repositoryName,
        filePath,
      })
    );
    if (!resp.fileContent) return null;
    return Buffer.from(resp.fileContent).toString('utf-8');
  } catch (error) {
    if (error instanceof FileDoesNotExistException) {
      return null;
    }
    throw error;
  }
}

/**
 * Check whether a file exists in the repo.
 */
async function fileExistsInRepo(
  config: FilingExecutorConfig,
  filePath: string
): Promise<boolean> {
  try {
    await codecommitClient.send(
      new GetFileCommand({
        repositoryName: config.repositoryName,
        filePath,
      })
    );
    return true;
  } catch (error) {
    if (error instanceof FileDoesNotExistException) {
      return false;
    }
    throw error;
  }
}

// ─── Main executor ───────────────────────────────────────────────────────────

/**
 * Execute a Filing Plan against CodeCommit and update the FSI.
 *
 * @param plan        The filing plan produced by the Classifier
 * @param config      Repository / branch / actor configuration
 * @param fsi         Current Folder Structure Index (will be mutated via pure helpers)
 * @param persistFSI  Optional callback to persist the updated FSI to AgentCore Memory
 */
export async function executeFilingPlan(
  plan: FilingPlan,
  config: FilingExecutorConfig,
  fsi: FolderStructureIndex,
  persistFSI?: FSIPersistCallback
): Promise<FilingExecutionResult> {
  // ── Validate file_path ──────────────────────────────────────────────────
  const pathValidation = validateFilePath(plan.file_path);
  if (!pathValidation.valid) {
    return {
      success: false,
      warnings: [],
      error: `Invalid file_path: ${pathValidation.errors.join('; ')}`,
    };
  }

  // ── Dispatch on action ──────────────────────────────────────────────────
  switch (plan.action) {
    case 'create':
      return executeCreate(plan, config, fsi, persistFSI);
    case 'append':
      return executeAppend(plan, config, fsi, persistFSI);
    case 'update':
      return executeUpdate(plan, config, fsi, persistFSI);
    case 'delete':
      return executeDelete(plan, config, fsi, persistFSI);
    case 'move':
      return executeMove(plan, config, fsi, persistFSI);
    default:
      return {
        success: false,
        warnings: [],
        error: `Unknown action: ${plan.action}`,
      };
  }
}


// ─── Action handlers ─────────────────────────────────────────────────────────

/**
 * Create a new file. If the file already exists, fall back to append.
 */
async function executeCreate(
  plan: FilingPlan,
  config: FilingExecutorConfig,
  fsi: FolderStructureIndex,
  persistFSI?: FSIPersistCallback
): Promise<FilingExecutionResult> {
  const warnings: string[] = [];

  // Check if file already exists → fall back to append
  const existing = await readFileFromRepo(config, plan.file_path);
  if (existing !== null) {
    console.warn(
      `[filing-executor] create: file already exists at ${plan.file_path}, falling back to append`
    );
    warnings.push(`File already exists at ${plan.file_path}, fell back to append`);
    return executeAppend(plan, config, fsi, persistFSI, warnings);
  }

  // Build content with wikilinks if related_files present
  let content = plan.content;
  const relatedFiles = plan.integration_metadata?.related_files ?? [];
  if (relatedFiles.length > 0) {
    content = injectWikilinks(content, relatedFiles);
  }

  // Commit the new file
  const commitResult = await commitWithRetry(
    config,
    `Create: ${plan.title}`,
    [{ filePath: plan.file_path, content }],
    []
  );

  if (!commitResult.success) {
    return { success: false, warnings, error: commitResult.error };
  }

  // Inject backlinks into related files (best-effort)
  for (const relatedPath of relatedFiles) {
    try {
      const relatedContent = await readFileFromRepo(config, relatedPath);
      if (relatedContent !== null) {
        const updated = injectBacklinks(relatedContent, plan.file_path, plan.title);
        if (updated !== relatedContent) {
          await commitWithRetry(
            config,
            `Backlink: ${plan.title} → ${relatedPath}`,
            [{ filePath: relatedPath, content: updated }],
            []
          );
        }
      }
    } catch (err) {
      console.warn(`[filing-executor] Failed to inject backlink into ${relatedPath}:`, err);
      warnings.push(`Failed to inject backlink into ${relatedPath}`);
    }
  }

  // Update FSI
  const updatedFSI = applyCreate(fsi, plan.file_path, {
    title: plan.title,
    updated_at: new Date().toISOString(),
  });
  await safePersistFSI(updatedFSI, persistFSI, warnings);

  return {
    success: true,
    commitId: commitResult.commitId,
    warnings,
  };
}

/**
 * Append content to an existing file. Falls back to create if file doesn't exist.
 */
async function executeAppend(
  plan: FilingPlan,
  config: FilingExecutorConfig,
  fsi: FolderStructureIndex,
  persistFSI?: FSIPersistCallback,
  existingWarnings: string[] = []
): Promise<FilingExecutionResult> {
  const warnings = [...existingWarnings];

  const existing = await readFileFromRepo(config, plan.file_path);

  // Fall back to create if file doesn't exist
  if (existing === null) {
    console.warn(
      `[filing-executor] append: file not found at ${plan.file_path}, falling back to create`
    );
    warnings.push(`File not found at ${plan.file_path}, fell back to create`);
    return executeCreate(
      { ...plan, action: 'create' },
      config,
      fsi,
      persistFSI
    );
  }

  // Warn about large files
  if (Buffer.byteLength(existing, 'utf-8') > LARGE_FILE_THRESHOLD_BYTES) {
    console.warn(
      `[filing-executor] append: file at ${plan.file_path} exceeds 100KB`
    );
    warnings.push(
      `File at ${plan.file_path} exceeds 100KB. Consider splitting it into smaller files.`
    );
  }

  // Apply content operation
  const result = applyContentOperation(
    existing,
    {
      action: 'append',
      content: plan.content,
      section_target: plan.section_target,
    },
    new Date().toISOString()
  );

  if (!result.success) {
    return { success: false, warnings: [...warnings, ...result.warnings], error: result.error };
  }
  warnings.push(...result.warnings);

  // Commit
  const commitResult = await commitWithRetry(
    config,
    `Append: ${plan.title}`,
    [{ filePath: plan.file_path, content: result.content }],
    []
  );

  if (!commitResult.success) {
    return { success: false, warnings, error: commitResult.error };
  }

  // FSI: file already exists, no structural change needed, but update metadata
  const updatedFSI = applyCreate(fsi, plan.file_path, {
    title: plan.title,
    updated_at: new Date().toISOString(),
  });
  await safePersistFSI(updatedFSI, persistFSI, warnings);

  return {
    success: true,
    commitId: commitResult.commitId,
    warnings,
  };
}

/**
 * Update a section of an existing file. Falls back to create if file doesn't exist.
 */
async function executeUpdate(
  plan: FilingPlan,
  config: FilingExecutorConfig,
  fsi: FolderStructureIndex,
  persistFSI?: FSIPersistCallback
): Promise<FilingExecutionResult> {
  const warnings: string[] = [];

  const existing = await readFileFromRepo(config, plan.file_path);

  // Fall back to create if file doesn't exist
  if (existing === null) {
    console.warn(
      `[filing-executor] update: file not found at ${plan.file_path}, falling back to create`
    );
    warnings.push(`File not found at ${plan.file_path}, fell back to create`);
    return executeCreate(
      { ...plan, action: 'create' },
      config,
      fsi,
      persistFSI
    );
  }

  const result = applyContentOperation(
    existing,
    {
      action: 'update',
      content: plan.content,
      section_target: plan.section_target,
    },
    new Date().toISOString()
  );

  if (!result.success) {
    return { success: false, warnings: [...warnings, ...result.warnings], error: result.error };
  }
  warnings.push(...result.warnings);

  const commitResult = await commitWithRetry(
    config,
    `Update: ${plan.title}`,
    [{ filePath: plan.file_path, content: result.content }],
    []
  );

  if (!commitResult.success) {
    return { success: false, warnings, error: commitResult.error };
  }

  const updatedFSI = applyCreate(fsi, plan.file_path, {
    title: plan.title,
    updated_at: new Date().toISOString(),
  });
  await safePersistFSI(updatedFSI, persistFSI, warnings);

  return {
    success: true,
    commitId: commitResult.commitId,
    warnings,
  };
}

/**
 * Delete a file or section.
 *
 * - Whole-file delete (no section_target): returns confirmationRequired=true, does NOT execute.
 * - Section delete (with section_target): executes immediately.
 */
async function executeDelete(
  plan: FilingPlan,
  config: FilingExecutorConfig,
  fsi: FolderStructureIndex,
  persistFSI?: FSIPersistCallback
): Promise<FilingExecutionResult> {
  const warnings: string[] = [];

  // ── Whole-file delete: require confirmation ─────────────────────────────
  if (!plan.section_target) {
    return {
      success: true,
      warnings: [],
      confirmationRequired: true,
    };
  }

  // ── Section delete: execute immediately ─────────────────────────────────
  const existing = await readFileFromRepo(config, plan.file_path);
  if (existing === null) {
    console.warn(`[filing-executor] delete: file not found at ${plan.file_path}`);
    return { success: true, warnings: ['File not found, nothing to delete'] };
  }

  const result = applyContentOperation(
    existing,
    {
      action: 'delete',
      section_target: plan.section_target,
    },
    new Date().toISOString()
  );

  if (!result.success) {
    return { success: false, warnings: [...warnings, ...result.warnings], error: result.error };
  }
  warnings.push(...result.warnings);

  const commitResult = await commitWithRetry(
    config,
    `Delete section "${plan.section_target}" from ${plan.file_path}`,
    [{ filePath: plan.file_path, content: result.content }],
    []
  );

  if (!commitResult.success) {
    return { success: false, warnings, error: commitResult.error };
  }

  // FSI: file still exists (only a section was removed), no structural change
  return {
    success: true,
    commitId: commitResult.commitId,
    warnings,
  };
}

/**
 * Move a file from file_path to destination_path.
 * Rejects if destination already exists. Uses a single commit with putFiles + deleteFiles.
 */
async function executeMove(
  plan: FilingPlan,
  config: FilingExecutorConfig,
  fsi: FolderStructureIndex,
  persistFSI?: FSIPersistCallback
): Promise<FilingExecutionResult> {
  const warnings: string[] = [];

  if (!plan.destination_path) {
    return {
      success: false,
      warnings: [],
      error: 'Move action requires a destination_path',
    };
  }

  // Validate destination path
  const destValidation = validateFilePath(plan.destination_path);
  if (!destValidation.valid) {
    return {
      success: false,
      warnings: [],
      error: `Invalid destination_path: ${destValidation.errors.join('; ')}`,
    };
  }

  // Reject if destination already exists
  const destExists = await fileExistsInRepo(config, plan.destination_path);
  if (destExists) {
    return {
      success: false,
      warnings: [],
      error: `Move rejected: destination ${plan.destination_path} already exists`,
    };
  }

  // Read source file
  const sourceContent = await readFileFromRepo(config, plan.file_path);
  if (sourceContent === null) {
    return {
      success: false,
      warnings: [],
      error: `Move rejected: source file ${plan.file_path} not found`,
    };
  }

  // Single commit: put destination + delete source
  const commitResult = await commitWithRetry(
    config,
    `Move: ${plan.file_path} → ${plan.destination_path}`,
    [{ filePath: plan.destination_path, content: sourceContent }],
    [plan.file_path]
  );

  if (!commitResult.success) {
    return { success: false, warnings, error: commitResult.error };
  }

  // Update FSI: move
  const updatedFSI = applyMove(fsi, plan.file_path, plan.destination_path, {
    title: plan.title,
    updated_at: new Date().toISOString(),
  });
  await safePersistFSI(updatedFSI, persistFSI, warnings);

  return {
    success: true,
    commitId: commitResult.commitId,
    warnings,
  };
}

// ─── Commit with retry-on-rebase ─────────────────────────────────────────────

interface CommitAttemptResult {
  success: boolean;
  commitId?: string;
  error?: string;
}

/**
 * Callback that builds putFiles content fresh on each attempt.
 * This ensures retries re-read the latest file content from CodeCommit.
 */
type BuildPutFilesCallback = () => Promise<Array<{ filePath: string; content: string }>>;

/**
 * Commit to CodeCommit with retry-with-rebase on ParentCommitIdOutdatedException.
 * Maximum MAX_RETRY_ATTEMPTS attempts.
 *
 * Accepts either static putFiles or a callback that builds them fresh on each attempt.
 * Using a callback ensures retries re-read the latest file content from CodeCommit,
 * avoiding stale-content conflicts.
 */
async function commitWithRetry(
  config: FilingExecutorConfig,
  commitMessage: string,
  putFilesOrBuilder: Array<{ filePath: string; content: string }> | BuildPutFilesCallback,
  deleteFilePaths: string[]
): Promise<CommitAttemptResult> {
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const parentCommitId = await getLatestCommitId(config);

      // Resolve putFiles: call builder on each attempt if it's a function
      const putFiles = typeof putFilesOrBuilder === 'function'
        ? await putFilesOrBuilder()
        : putFilesOrBuilder;

      const resp = await codecommitClient.send(
        new CreateCommitCommand({
          repositoryName: config.repositoryName,
          branchName: config.branchName,
          parentCommitId: parentCommitId || undefined,
          authorName: 'Second Brain Agent',
          email: 'agent@second-brain.local',
          commitMessage,
          putFiles: putFiles.map((f) => ({
            filePath: f.filePath,
            fileContent: Buffer.from(f.content),
          })),
          deleteFiles: deleteFilePaths.map((fp) => ({ filePath: fp })),
        })
      );

      return { success: true, commitId: resp.commitId ?? '' };
    } catch (error) {
      if (error instanceof ParentCommitIdOutdatedException) {
        console.warn(
          `[filing-executor] Commit conflict (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}), retrying with rebase`
        );
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          continue;
        }
        return {
          success: false,
          error: `Commit failed after ${MAX_RETRY_ATTEMPTS} retries due to concurrent modifications`,
        };
      }
      throw error;
    }
  }

  return {
    success: false,
    error: `Commit failed after ${MAX_RETRY_ATTEMPTS} retries`,
  };
}

// ─── FSI persistence helper ──────────────────────────────────────────────────

/**
 * Safely persist the FSI. Logs errors but does NOT throw (Requirement 11.4).
 */
async function safePersistFSI(
  fsi: FolderStructureIndex,
  persistFSI: FSIPersistCallback | undefined,
  warnings: string[]
): Promise<void> {
  if (!persistFSI) return;
  try {
    await persistFSI(fsi);
  } catch (err) {
    console.error('[filing-executor] Failed to persist FSI:', err);
    warnings.push('Failed to persist Folder Structure Index update');
  }
}
