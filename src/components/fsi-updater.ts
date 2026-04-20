/**
 * Folder Structure Index Updater
 *
 * Pure functions for updating the FSI in response to file operations.
 * All functions return a new FSI object without mutating the input.
 *
 * Validates: Requirements 3.2, 11.2, 11.5, 11.6, 11.7
 */

import { FolderStructureIndex, FSIEntry } from '../types/folder-structure-index';

/**
 * Optional metadata to attach to a newly created file entry.
 */
export interface FSIFileMetadata {
  title?: string;
  tags?: string[];
  updated_at?: string;
}

/**
 * Returns all intermediate folder paths between the repo root and the given file path.
 * For example, "10_Work/Project_Alpha/notes.md" returns ["10_Work", "10_Work/Project_Alpha"].
 */
export function getIntermediateFolders(filePath: string): string[] {
  const parts = filePath.split('/');
  // Remove the filename (last segment)
  const folderParts = parts.slice(0, -1);
  const folders: string[] = [];
  for (let i = 1; i <= folderParts.length; i++) {
    folders.push(folderParts.slice(0, i).join('/'));
  }
  return folders;
}

/**
 * Checks if a folder has any children (files or subfolders) in the FSI.
 */
export function isFolderEmpty(fsi: FolderStructureIndex, folderPath: string): boolean {
  const prefix = folderPath + '/';
  return !fsi.entries.some((entry) => entry.path.startsWith(prefix));
}

/**
 * Apply a create operation to the FSI.
 * Adds the file entry and all intermediate folder entries that don't already exist.
 * Returns a new FSI object (does not mutate input).
 */
export function applyCreate(
  fsi: FolderStructureIndex,
  filePath: string,
  metadata?: FSIFileMetadata
): FolderStructureIndex {
  const existingPaths = new Set(fsi.entries.map((e) => e.path));
  const newEntries: FSIEntry[] = [...fsi.entries];

  // Add intermediate folders if they don't exist
  const folders = getIntermediateFolders(filePath);
  for (const folder of folders) {
    if (!existingPaths.has(folder)) {
      newEntries.push({ path: folder, type: 'folder' });
      existingPaths.add(folder);
    }
  }

  // Add the file entry if it doesn't exist
  if (!existingPaths.has(filePath)) {
    const fileEntry: FSIEntry = { path: filePath, type: 'file' };
    if (metadata?.title) fileEntry.title = metadata.title;
    if (metadata?.tags) fileEntry.tags = metadata.tags;
    if (metadata?.updated_at) fileEntry.updated_at = metadata.updated_at;
    newEntries.push(fileEntry);
  }

  return {
    ...fsi,
    entries: newEntries,
  };
}

/**
 * Apply a delete operation to the FSI.
 * Removes the file entry and any parent folders that become empty as a result.
 * Returns a new FSI object (does not mutate input).
 */
export function applyDelete(
  fsi: FolderStructureIndex,
  filePath: string
): FolderStructureIndex {
  // Remove the file entry
  let newEntries = fsi.entries.filter((e) => e.path !== filePath);

  // Check parent folders from deepest to shallowest, remove if empty
  const folders = getIntermediateFolders(filePath);
  for (let i = folders.length - 1; i >= 0; i--) {
    const folder = folders[i];
    const tempFsi: FolderStructureIndex = { ...fsi, entries: newEntries };
    if (isFolderEmpty(tempFsi, folder)) {
      newEntries = newEntries.filter((e) => e.path !== folder);
    } else {
      // If this folder is not empty, no parent folders above it will become empty due to this delete
      break;
    }
  }

  return {
    ...fsi,
    entries: newEntries,
  };
}

/**
 * Apply a move operation to the FSI.
 * Removes the source file, adds the destination file + intermediate folders,
 * and removes empty parent folders of the source.
 * Returns a new FSI object (does not mutate input).
 */
export function applyMove(
  fsi: FolderStructureIndex,
  sourcePath: string,
  destPath: string,
  metadata?: FSIFileMetadata
): FolderStructureIndex {
  // Find the source entry to preserve its metadata
  const sourceEntry = fsi.entries.find((e) => e.path === sourcePath);
  const resolvedMetadata: FSIFileMetadata | undefined = metadata ?? (sourceEntry
    ? { title: sourceEntry.title, tags: sourceEntry.tags, updated_at: sourceEntry.updated_at }
    : undefined);

  // First, delete the source
  const afterDelete = applyDelete(fsi, sourcePath);

  // Then, create at the destination
  const afterCreate = applyCreate(afterDelete, destPath, resolvedMetadata);

  return afterCreate;
}

/**
 * Rebuild the FSI from a list of files in the repository.
 * Used when the FSI commit_id doesn't match CodeCommit HEAD.
 */
export function rebuildFSIFromTree(
  files: Array<{ path: string; title?: string }>
): FolderStructureIndex {
  const entries: FSIEntry[] = [];
  const folderPaths = new Set<string>();

  for (const file of files) {
    // Add intermediate folders
    const folders = getIntermediateFolders(file.path);
    for (const folder of folders) {
      if (!folderPaths.has(folder)) {
        folderPaths.add(folder);
        entries.push({ path: folder, type: 'folder' });
      }
    }

    // Add the file entry
    const fileEntry: FSIEntry = { path: file.path, type: 'file' };
    if (file.title) fileEntry.title = file.title;
    entries.push(fileEntry);
  }

  return {
    version: 1,
    last_updated: new Date().toISOString(),
    commit_id: '',
    entries,
  };
}
