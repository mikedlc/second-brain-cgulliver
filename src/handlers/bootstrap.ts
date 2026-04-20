/**
 * Bootstrap Custom Resource Handler
 * 
 * Seeds the CodeCommit repository with:
 * - Organic folder structure: 00_System/, 10_Work/, 20_Personal/, 25_Real_Estate/, 30_Archive/, 40_Exports/, _INBOX/
 * - Default system prompt: 00_System/agent-system-prompt.md
 * 
 * Bootstrap is destructive: deletes all existing content before creating scaffold.
 * 
 * Validates: Requirements 6.1, 6.2, 6.3
 */

import {
  CodeCommitClient,
  GetBranchCommand,
  CreateCommitCommand,
  GetFolderCommand,
  BranchDoesNotExistException,
} from '@aws-sdk/client-codecommit';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';

const REPOSITORY_NAME = process.env.REPOSITORY_NAME!;

const codecommitClient = new CodeCommitClient({});

// Default system prompt content — loaded from 00_System/agent-system-prompt.md at runtime
const DEFAULT_SYSTEM_PROMPT = `# Second Brain Agent — Organic Filing Classifier

## Operating Contract

- The user thinks and talks. The bot maintains the record.
- The user never files, tags, or organizes.
- The bot determines WHERE content lives and HOW to integrate it.
- Every message is either captured, discussed, queried, or used to update status.

## Folder Structure

Top-level areas use the NN_Name format:

- 00_System — Agent config, templates, pending drafts
- 10_Work — Professional projects, career, work notes
- 20_Personal — Personal life, health, hobbies, relationships
- 25_Real_Estate — Property, renovations, contractors
- 30_Archive — Completed/inactive content (preserves original structure)
- 40_Exports — Generated reports, summaries
- _INBOX — Truly ambiguous content only (last resort)

Subfolders are created organically as topics emerge (e.g., 25_Real_Estate/CNC_Mill_Build/).

## Filing Rules

1. Determine the AREA from content domain
2. Check the Folder Structure Index for existing files on this topic
3. If a relevant file exists, prefer append or update over create
4. If no relevant file exists, create in the appropriate area/subfolder
5. Create subfolders organically when a new topic warrants its own location

## Interaction Modes

- discuss — Conversational exploration, no filing. Accumulate context across messages.
- capture — Commit content to the Knowledge Repository.
- query — Retrieve and synthesize existing knowledge.
- status_update — Update project status.

## Filing Plan JSON Output Contract

Return a single JSON object (no prose, no explanation outside JSON):

\`\`\`json
{
  "intent": "capture | discuss | query | status_update",
  "intent_confidence": 0.0-1.0,
  "file_path": "NN_Area/Subfolder/filename.md",
  "action": "create | append | update | delete | move",
  "destination_path": "path (required for move)",
  "section_target": "## Heading (required for update/section-delete)",
  "integration_metadata": {
    "related_files": ["path1.md", "path2.md"],
    "content_disposition": "new_topic | continuation | supersedes | contradicts | refines",
    "confidence": 0.0-1.0
  },
  "title": "Concise title",
  "content": "Markdown body",
  "reasoning": "1-2 sentences explaining the filing decision",
  "discuss_response": "Conversational reply (for discuss intent)",
  "session_id": "ds-xxxxxxx (for discuss continuity)",
  "task_details": { "title": "Imperative task", "context": "Details" }
}
\`\`\`

## Naming Conventions

- Areas: NN_Name (e.g., 10_Work, 25_Real_Estate)
- Subfolders: Descriptive_Name with underscores (e.g., CNC_Mill_Build, Solar_Project)
- Files: kebab-case.md (e.g., research-notes.md, supplier-contacts.md)

## Action Rules

### create
Use when the content represents a new topic with no existing file.

### append
Use when the content adds information to an existing topic. The Content Integrator adds content under the most relevant heading, or creates a new section.

### update
Use when the content contradicts, supersedes, or refines existing content. Requires section_target to identify which part of the file to modify.

### delete
Use when the user requests removal. For full-file delete, the Worker asks for confirmation. For section-level delete (with section_target), no confirmation needed.

### move
Use when the user requests content be relocated or archived. Requires destination_path. For archiving, use 30_Archive/ preserving the original subfolder structure.

## Discuss Mode Rules

- Respond conversationally. Do NOT produce file operations.
- Draw on the Folder Structure Index and existing file content to inform responses.
- Accumulate context across messages within the session.
- When the user says "file this" / "save this" / "commit this" / "record this", produce a capture Filing Plan that distills the full conversation.

## _INBOX Rules

Use _INBOX only for truly ambiguous content that does not fit any area. If you can determine the domain with reasonable confidence, file it in the appropriate area instead. _INBOX is a last resort, not a default.
`;

// Organic folder structure with .gitkeep files
const FOLDER_STRUCTURE = [
  '00_System/.gitkeep',
  '00_System/Pending/.gitkeep',
  '00_System/Templates/.gitkeep',
  '10_Work/.gitkeep',
  '20_Personal/.gitkeep',
  '25_Real_Estate/.gitkeep',
  '30_Archive/.gitkeep',
  '40_Exports/.gitkeep',
  '_INBOX/.gitkeep',
];

/**
 * Check if repository has any commits (main branch exists)
 */
async function hasCommits(): Promise<boolean> {
  try {
    await codecommitClient.send(
      new GetBranchCommand({
        repositoryName: REPOSITORY_NAME,
        branchName: 'main',
      })
    );
    return true;
  } catch (error) {
    if (error instanceof BranchDoesNotExistException) {
      return false;
    }
    throw error;
  }
}

/**
 * Get the latest commit ID for the main branch
 */
async function getLatestCommitId(): Promise<string> {
  const result = await codecommitClient.send(
    new GetBranchCommand({
      repositoryName: REPOSITORY_NAME,
      branchName: 'main',
    })
  );
  return result.branch?.commitId || '';
}

/**
 * List all files in the repository for deletion
 */
async function listAllFiles(commitId: string): Promise<string[]> {
  const files: string[] = [];

  async function walkFolder(folderPath: string): Promise<void> {
    try {
      const result = await codecommitClient.send(
        new GetFolderCommand({
          repositoryName: REPOSITORY_NAME,
          commitSpecifier: commitId,
          folderPath,
        })
      );

      // Add files
      if (result.files) {
        for (const file of result.files) {
          if (file.relativePath) {
            const fullPath = folderPath === '/' ? file.relativePath : `${folderPath}/${file.relativePath}`;
            files.push(fullPath);
          }
        }
      }

      // Recurse into subfolders
      if (result.subFolders) {
        for (const folder of result.subFolders) {
          if (folder.relativePath) {
            const fullPath = folderPath === '/' ? folder.relativePath : `${folderPath}/${folder.relativePath}`;
            await walkFolder(fullPath);
          }
        }
      }
    } catch {
      // Folder may not exist, ignore
    }
  }

  await walkFolder('/');
  return files;
}

/**
 * Create initial commit with organic folder structure and system prompt.
 * Used when the repository has no commits.
 */
async function bootstrapEmptyRepository(): Promise<string> {
  const putFiles = [
    // Folder structure
    ...FOLDER_STRUCTURE.map((path) => ({
      filePath: path,
      fileContent: Buffer.from(''),
    })),
    // System prompt
    {
      filePath: '00_System/agent-system-prompt.md',
      fileContent: Buffer.from(DEFAULT_SYSTEM_PROMPT),
    },
  ];

  const response = await codecommitClient.send(
    new CreateCommitCommand({
      repositoryName: REPOSITORY_NAME,
      branchName: 'main',
      authorName: 'Second Brain Bootstrap',
      email: 'bootstrap@second-brain.local',
      commitMessage: 'Initial repository setup with organic folder structure and system prompt',
      putFiles,
    })
  );

  return response.commitId || 'unknown';
}

/**
 * Destructive bootstrap: delete all existing files and create fresh organic scaffold.
 * Used when the repository already has content.
 */
async function bootstrapExistingRepository(): Promise<string> {
  const commitId = await getLatestCommitId();
  const existingFiles = await listAllFiles(commitId);

  const deleteFiles = existingFiles.map((filePath) => ({
    filePath,
  }));

  const putFiles = [
    // Folder structure
    ...FOLDER_STRUCTURE.map((path) => ({
      filePath: path,
      fileContent: Buffer.from(''),
    })),
    // System prompt
    {
      filePath: '00_System/agent-system-prompt.md',
      fileContent: Buffer.from(DEFAULT_SYSTEM_PROMPT),
    },
  ];

  const response = await codecommitClient.send(
    new CreateCommitCommand({
      repositoryName: REPOSITORY_NAME,
      branchName: 'main',
      parentCommitId: commitId,
      authorName: 'Second Brain Bootstrap',
      email: 'bootstrap@second-brain.local',
      commitMessage: 'Destructive bootstrap: organic folder structure and system prompt',
      deleteFiles: deleteFiles.length > 0 ? deleteFiles : undefined,
      putFiles,
    })
  );

  return response.commitId || 'unknown';
}

/**
 * Lambda handler for CloudFormation custom resource
 */
export async function handler(
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> {
  console.log('Bootstrap event:', JSON.stringify(event, null, 2));

  const physicalResourceId = `bootstrap-${REPOSITORY_NAME}`;

  try {
    if (event.RequestType === 'Delete') {
      // Nothing to clean up on delete
      return {
        Status: 'SUCCESS',
        PhysicalResourceId: physicalResourceId,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
      };
    }

    // For Create and Update: always bootstrap (destructive)
    const repoHasCommits = await hasCommits();

    let commitId: string;
    if (!repoHasCommits) {
      console.log('Repository is empty, bootstrapping...');
      commitId = await bootstrapEmptyRepository();
    } else {
      console.log('Repository has existing content, performing destructive bootstrap...');
      commitId = await bootstrapExistingRepository();
    }

    console.log('Bootstrap complete, commit:', commitId);

    return {
      Status: 'SUCCESS',
      PhysicalResourceId: physicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {
        CommitId: commitId,
        Bootstrapped: 'true',
      },
    };
  } catch (error) {
    console.error('Bootstrap failed:', error);
    return {
      Status: 'FAILED',
      PhysicalResourceId: physicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
