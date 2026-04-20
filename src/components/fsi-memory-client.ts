/**
 * FSI Storage Client — CodeCommit operations for the Folder Structure Index
 *
 * Retrieves and persists the Folder Structure Index document in CodeCommit
 * at `00_System/.fsi-cache.json`.
 *
 * Validates: Requirements 3.3, 3.5, 11.3, 11.4
 */

import {
  CodeCommitClient,
  GetBranchCommand,
  GetFileCommand,
  CreateCommitCommand,
  FileDoesNotExistException,
} from '@aws-sdk/client-codecommit';
import type { FolderStructureIndex } from '../types/folder-structure-index';

// ─── Constants ───────────────────────────────────────────────────────────────

const FSI_CACHE_PATH = '00_System/.fsi-cache.json';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Configuration for the FSI storage client.
 */
export interface FSIStorageConfig {
  repositoryName: string;
  branchName: string;
}

/**
 * @deprecated Use FSIStorageConfig instead
 */
export type FSIMemoryConfig = FSIStorageConfig;

// ─── Client ──────────────────────────────────────────────────────────────────

const codecommitClient = new CodeCommitClient({});

/**
 * Retrieve the Folder Structure Index from CodeCommit (00_System/.fsi-cache.json).
 *
 * Returns null if the FSI file is not found or if retrieval fails.
 * Logs a warning on failure but does NOT throw.
 *
 * @param repositoryName  The CodeCommit repository name
 * @param branchName      The branch to read from
 */
export async function retrieveFSI(
  repositoryName: string,
  branchName: string
): Promise<FolderStructureIndex | null> {
  try {
    const response = await codecommitClient.send(
      new GetFileCommand({
        repositoryName,
        filePath: FSI_CACHE_PATH,
        commitSpecifier: branchName,
      })
    );

    if (!response.fileContent) {
      console.warn(
        `[fsi-memory-client] No FSI found at ${FSI_CACHE_PATH} in ${repositoryName}/${branchName}`
      );
      return null;
    }

    const raw = Buffer.from(response.fileContent).toString('utf-8');
    const fsi: FolderStructureIndex = JSON.parse(raw);
    return fsi;
  } catch (error) {
    if (error instanceof FileDoesNotExistException) {
      console.warn(
        `[fsi-memory-client] FSI cache file not found at ${FSI_CACHE_PATH}`
      );
      return null;
    }
    console.warn('[fsi-memory-client] Failed to retrieve FSI:', error);
    return null;
  }
}

/**
 * Persist the Folder Structure Index to CodeCommit (00_System/.fsi-cache.json).
 *
 * Logs an error on failure but does NOT throw (Requirement 11.4).
 *
 * @param repositoryName  The CodeCommit repository name
 * @param branchName      The branch to write to
 * @param fsi             The updated Folder Structure Index to persist
 */
export async function persistFSI(
  repositoryName: string,
  branchName: string,
  fsi: FolderStructureIndex
): Promise<void> {
  try {
    const branchResp = await codecommitClient.send(
      new GetBranchCommand({
        repositoryName,
        branchName,
      })
    );

    const parentCommitId = branchResp.branch?.commitId;

    const content = JSON.stringify(fsi, null, 2);

    await codecommitClient.send(
      new CreateCommitCommand({
        repositoryName,
        branchName,
        parentCommitId,
        authorName: 'Second Brain Agent',
        email: 'agent@second-brain.local',
        commitMessage: 'Update FSI cache',
        putFiles: [
          {
            filePath: FSI_CACHE_PATH,
            fileContent: Buffer.from(content),
          },
        ],
      })
    );
  } catch (error) {
    console.error('[fsi-memory-client] Failed to persist FSI:', error);
    // Do NOT throw — Requirement 11.4: FSI failure must not roll back file commit
  }
}
