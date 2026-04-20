/**
 * FSI Memory Client — AgentCore Memory operations for the Folder Structure Index
 *
 * Retrieves and persists the Folder Structure Index document in AgentCore Memory
 * under the namespace `/structure/{actorId}`.
 *
 * Validates: Requirements 3.3, 3.5, 11.3, 11.4
 */

import {
  BedrockAgentCoreClient,
} from '@aws-sdk/client-bedrock-agentcore';
import type { FolderStructureIndex } from '../types/folder-structure-index';

// ─── Constants ───────────────────────────────────────────────────────────────

const FSI_NAMESPACE_PREFIX = '/structure';
const FSI_DOCUMENT_KEY = 'folder-structure-index';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Configuration for the FSI memory client.
 */
export interface FSIMemoryConfig {
  memoryId: string;
  actorId: string;
  region: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * Retrieve the Folder Structure Index from AgentCore Memory.
 *
 * Returns null if the FSI is not found or if retrieval fails.
 * Logs a warning on failure but does NOT throw.
 *
 * @param memoryId  The AgentCore Memory store identifier
 * @param actorId   The actor (user) identifier for namespace scoping
 * @param region    AWS region
 */
export async function retrieveFSI(
  memoryId: string,
  actorId: string,
  region: string
): Promise<FolderStructureIndex | null> {
  try {
    const client = new BedrockAgentCoreClient({ region });
    const namespace = `${FSI_NAMESPACE_PREFIX}/${actorId}`;

    // Use the AgentCore Memory retrieve_memories pattern
    // The SDK command retrieves documents from a memory namespace
    const command = {
      memoryId,
      namespace,
      key: FSI_DOCUMENT_KEY,
    };

    // AgentCore Memory stores documents as JSON blobs.
    // We use the low-level send pattern consistent with the rest of the project.
    const response = await (client as any).send({
      ...command,
      constructor: { name: 'RetrieveMemoryCommand' },
    });

    if (!response?.content) {
      console.warn(
        `[fsi-memory-client] No FSI found for actor ${actorId} in memory ${memoryId}`
      );
      return null;
    }

    const fsi: FolderStructureIndex = JSON.parse(
      typeof response.content === 'string'
        ? response.content
        : Buffer.from(response.content).toString('utf-8')
    );

    return fsi;
  } catch (error) {
    console.warn('[fsi-memory-client] Failed to retrieve FSI:', error);
    return null;
  }
}

/**
 * Persist the Folder Structure Index to AgentCore Memory.
 *
 * Logs an error on failure but does NOT throw (Requirement 11.4).
 *
 * @param memoryId  The AgentCore Memory store identifier
 * @param actorId   The actor (user) identifier for namespace scoping
 * @param fsi       The updated Folder Structure Index to persist
 * @param region    AWS region
 */
export async function persistFSI(
  memoryId: string,
  actorId: string,
  fsi: FolderStructureIndex,
  region: string
): Promise<void> {
  try {
    const client = new BedrockAgentCoreClient({ region });
    const namespace = `${FSI_NAMESPACE_PREFIX}/${actorId}`;

    const content = JSON.stringify(fsi);

    // Use the AgentCore Memory store pattern
    const command = {
      memoryId,
      namespace,
      key: FSI_DOCUMENT_KEY,
      content,
    };

    await (client as any).send({
      ...command,
      constructor: { name: 'StoreMemoryCommand' },
    });
  } catch (error) {
    console.error('[fsi-memory-client] Failed to persist FSI:', error);
    // Do NOT throw — Requirement 11.4: FSI failure must not roll back file commit
  }
}
