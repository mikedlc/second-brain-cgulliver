/**
 * Folder Structure Index Types
 *
 * Defines the FSI document structure stored in AgentCore Memory.
 * The FSI represents the current state of the Knowledge Repository's directory tree.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

/**
 * A single entry in the Folder Structure Index
 */
export interface FSIEntry {
  /** Full path relative to repo root */
  path: string;
  /** Type: "folder" or "file" */
  type: 'folder' | 'file';
  /** Front-matter title (for files only) */
  title?: string;
  /** Front-matter tags (for files only) */
  tags?: string[];
  /** Last updated timestamp */
  updated_at?: string;
}

/**
 * The complete Folder Structure Index document
 */
export interface FolderStructureIndex {
  /** Schema version for future migrations */
  version: number;
  /** Timestamp of last update */
  last_updated: string;
  /** Commit ID this index reflects */
  commit_id: string;
  /** All entries in the repository */
  entries: FSIEntry[];
}
