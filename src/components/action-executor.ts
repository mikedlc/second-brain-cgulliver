/**
 * Action Plan Executor Component
 * 
 * Executes side effects in order: CodeCommit → SES → Slack
 * Handles rate limiting, partial failures, and recovery.
 * 
 * Validates: Requirements 43, 44, 50
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
import type { ActionPlan } from './action-plan';
import { validateActionPlan } from './action-plan';
import {
  writeFile,
  appendToFile,
  getLatestCommitId,
  type KnowledgeStoreConfig,
  type CommitResult,
} from './knowledge-store';
import {
  updateExecutionState,
  markPartialFailure,
  getCompletedSteps,
  type IdempotencyConfig,
  type CompletedSteps,
} from './idempotency-guard';
import {
  createReceipt,
  appendReceipt,
  type ReceiptAction,
  type SlackContext,
} from './receipt-logger';
import type { SystemPromptMetadata } from './system-prompt-loader';
import { generateSbId } from './sb-id';
import { generateFrontMatter, generateWikilink, generateTagsAndLinksFooter, type FrontMatter } from './markdown-templates';
import { extractTags } from './tag-extractor';
import {
  searchKnowledgeBase,
  DEFAULT_SEARCH_CONFIG,
  type KnowledgeFileWithMeta,
  parseFrontMatter,
} from './knowledge-search';
import type { Classification, LinkedItem } from '../types';

// Execution configuration
export interface ExecutorConfig {
  knowledgeStore: KnowledgeStoreConfig;
  idempotency: IdempotencyConfig;
  sesRegion: string;
  slackBotTokenParam: string;
  mailDropParam: string;
  emailMode: 'live' | 'log';
  senderEmail: string;
}

// Execution result
export interface ExecutionResult {
  success: boolean;
  commitId?: string;
  receiptCommitId?: string;
  slackReplyTs?: string;
  emailMessageId?: string;
  filesModified?: string[];
  fileContents?: string[];  // Final content with front matter (for sync)
  generatedSbId?: string;   // SB_ID generated for new items (for cross-linking)
  error?: string;
  validationErrors?: string[];
  completedSteps: CompletedSteps;
}

// Rate limit configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

// AWS clients
const sesClient = new SESClient({});
const ssmClient = new SSMClient({});

// Cached SSM values with TTL (FINDING-SEC-01)
let cachedBotToken: string | null = null;
let cachedMailDrop: string | null = null;
let botTokenCachedAt: number = 0;
let mailDropCachedAt: number = 0;
const SECRET_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoff(attempt: number, retryAfter?: number): number {
  if (retryAfter) {
    return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  }
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Get Slack bot token from SSM
 * Caches for 1 hour to support secret rotation without redeployment
 */
async function getBotToken(paramName: string): Promise<string> {
  const now = Date.now();
  if (cachedBotToken && (now - botTokenCachedAt) < SECRET_CACHE_TTL_MS) return cachedBotToken;

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    })
  );

  cachedBotToken = response.Parameter?.Value || '';
  botTokenCachedAt = now;
  return cachedBotToken;
}

/**
 * Get OmniFocus Mail Drop email from SSM
 * Caches for 1 hour to support secret rotation without redeployment
 */
async function getMailDropEmail(paramName: string): Promise<string> {
  const now = Date.now();
  if (cachedMailDrop && (now - mailDropCachedAt) < SECRET_CACHE_TTL_MS) return cachedMailDrop;

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    })
  );

  cachedMailDrop = response.Parameter?.Value || '';
  mailDropCachedAt = now;
  return cachedMailDrop;
}

/**
 * Check if classification requires front matter
 */
function requiresFrontMatter(classification: Classification | null): classification is 'idea' | 'decision' | 'project' {
  return classification === 'idea' || classification === 'decision' || classification === 'project';
}

/**
 * Source metadata for front matter
 */
interface SourceMetadata {
  channelId: string;
  messageTs: string;
}

/**
 * Inject front matter into content for idea/decision/project
 * Tags and links are added at the bottom of the note content.
 * 
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5
 * Validates: Requirements 3.1, 3.2 (cross-item linking)
 */
function injectFrontMatter(
  content: string,
  classification: 'idea' | 'decision' | 'project',
  title: string,
  source?: SourceMetadata,
  linkedItems?: LinkedItem[],
  options?: {
    summary?: string;      // LLM-generated summary (preferred)
    tags?: string[];       // LLM-generated tags (preferred)
    parent?: string;       // Parent item sb_id (e.g., "sb-1234567")
  }
): { content: string; sbId: string } {
  // Generate unique SB_ID
  const sbId = generateSbId();
  
  // Use LLM-generated tags if provided, otherwise fall back to extraction
  const tags = options?.tags && options.tags.length > 0
    ? options.tags
    : extractTags(content, title);
  
  // Build links from linked_items (cross-item linking)
  const links = linkedItems && linkedItems.length > 0
    ? linkedItems.map(item => `[[${item.sb_id}]]`)
    : [];
  
  // Use LLM-generated summary if provided, otherwise generate from content
  const summary = options?.summary || generateSummary(content, title);
  
  // Build front matter (tags and links in BOTH front matter AND footer)
  const frontMatter: FrontMatter = {
    id: sbId,
    type: classification,
    title: title,
    summary: summary,
    parent: options?.parent ? `[[${options.parent}]]` : undefined,
    created_at: new Date().toISOString(),
    tags: tags,   // Tags in front matter for machine queries
    links: links, // Links in front matter for graph queries
  };
  
  // Add source metadata if provided
  if (source) {
    frontMatter.source = {
      channel: source.channelId,
      message_ts: source.messageTs,
    };
  }
  
  // Generate front matter string
  const frontMatterStr = generateFrontMatter(frontMatter);
  
  // Generate tags and links footer for bottom of note
  const footer = generateTagsAndLinksFooter(tags, links);
  
  // Check if content already has front matter (shouldn't, but be safe)
  if (content.startsWith('---\n')) {
    return { content, sbId };
  }
  
  return {
    content: frontMatterStr + content + footer,
    sbId,
  };
}

/**
 * Generate a one-line summary from content (fallback when LLM doesn't provide one)
 * Takes first sentence or ~100 chars, whichever is shorter
 */
function generateSummary(content: string, title: string): string {
  // Remove markdown formatting
  const clean = content
    .replace(/^#+\s+.*/gm, '') // Remove headings
    .replace(/\*\*|__/g, '')   // Remove bold
    .replace(/\*|_/g, '')      // Remove italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
    .replace(/\n+/g, ' ')      // Collapse newlines
    .trim();
  
  if (!clean || clean.length < 10) {
    return title; // Fall back to title
  }
  
  // Find first sentence
  const sentenceEnd = clean.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd < 150) {
    return clean.slice(0, sentenceEnd + 1).trim();
  }
  
  // Otherwise take first ~100 chars at word boundary
  if (clean.length <= 100) {
    return clean;
  }
  
  const truncated = clean.slice(0, 100);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 50 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Find related items by matching tags
 * 
 * Searches the knowledge base for items that share tags with the new item.
 * Returns up to 5 related items, sorted by number of matching tags.
 */
async function findRelatedByTags(
  config: KnowledgeStoreConfig,
  tags: string[],
  excludePath?: string
): Promise<Array<{ sbId: string; title: string; matchingTags: string[] }>> {
  if (tags.length === 0) {
    return [];
  }

  const client = new CodeCommitClient({});
  
  try {
    const searchResult = await searchKnowledgeBase(client, {
      repositoryName: config.repositoryName,
      branchName: config.branchName,
      maxFilesToSearch: DEFAULT_SEARCH_CONFIG.maxFilesToSearch || 50,
      maxExcerptLength: DEFAULT_SEARCH_CONFIG.maxExcerptLength || 500,
    });

    const tagsLower = tags.map(t => t.toLowerCase());
    const related: Array<{ sbId: string; title: string; matchingTags: string[]; score: number }> = [];

    for (const file of searchResult.files) {
      // Skip the file we're creating
      if (excludePath && file.path === excludePath) {
        continue;
      }

      // Must have front matter with id and tags
      if (!file.frontMatter?.id || !file.frontMatter?.tags || !file.frontMatter?.title) {
        continue;
      }

      // Find matching tags
      const fileTags = file.frontMatter.tags.map(t => t.toLowerCase());
      const matchingTags = tags.filter(t => fileTags.includes(t.toLowerCase()));

      if (matchingTags.length > 0) {
        related.push({
          sbId: file.frontMatter.id,
          title: file.frontMatter.title,
          matchingTags,
          score: matchingTags.length,
        });
      }
    }

    // Sort by number of matching tags (descending), take top 5
    return related
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ sbId, title, matchingTags }) => ({ sbId, title, matchingTags }));
  } catch (error) {
    // Don't fail the whole operation if related search fails
    console.warn('Failed to find related items', { error });
    return [];
  }
}

/**
 * Find a file by its SB_ID
 * 
 * Searches the knowledge base for a file with matching SB_ID in front matter.
 * Returns the file path and content if found.
 * 
 * Validates: Requirement 4.1 (backlink creation)
 */
async function findFileBySbId(
  config: KnowledgeStoreConfig,
  sbId: string
): Promise<{ path: string; content: string } | null> {
  const client = new CodeCommitClient({});
  
  try {
    const searchResult = await searchKnowledgeBase(client, {
      repositoryName: config.repositoryName,
      branchName: config.branchName,
      maxFilesToSearch: DEFAULT_SEARCH_CONFIG.maxFilesToSearch || 50,
      maxExcerptLength: DEFAULT_SEARCH_CONFIG.maxExcerptLength || 500,
    });

    for (const file of searchResult.files) {
      if (file.frontMatter?.id === sbId) {
        return {
          path: file.path,
          content: file.content,
        };
      }
    }

    return null;
  } catch (error) {
    console.warn('Failed to find file by SB_ID', { sbId, error });
    return null;
  }
}

/**
 * Regenerate file content with updated front matter
 * 
 * Replaces the existing front matter with new front matter while preserving body content.
 */
function regenerateFileWithFrontMatter(
  content: string,
  newFrontMatter: FrontMatter
): string {
  // Find the end of existing front matter
  if (!content.startsWith('---\n')) {
    // No existing front matter, just prepend
    return generateFrontMatter(newFrontMatter) + content;
  }
  
  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    // Malformed front matter, prepend new one
    return generateFrontMatter(newFrontMatter) + content;
  }
  
  // Extract body content (after the closing ---)
  const bodyContent = content.slice(endIndex + 5); // Skip '\n---\n'
  
  // Generate new front matter and combine with body
  return generateFrontMatter(newFrontMatter) + bodyContent;
}

/**
 * Add backlinks to linked items
 * 
 * For each linked item, finds its file and adds a backlink to the new item.
 * Skips duplicates and preserves existing links.
 * Logs warnings on failures but continues processing.
 * 
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4
 */
async function addBacklinks(
  config: KnowledgeStoreConfig,
  newItemSbId: string,
  linkedItems: LinkedItem[],
  newItemType?: string,
  newItemTitle?: string
): Promise<void> {
  console.log('addBacklinks called', {
    newItemSbId,
    linkedItemsCount: linkedItems.length,
    newItemType,
    newItemTitle,
  });
  
  for (const linkedItem of linkedItems) {
    try {
      console.log('Processing backlink for', { linkedItemSbId: linkedItem.sb_id, linkedItemTitle: linkedItem.title });
      
      // Find the file for this SB_ID
      const file = await findFileBySbId(config, linkedItem.sb_id);
      if (!file) {
        console.warn(`Could not find file for backlink: ${linkedItem.sb_id}`);
        continue;
      }
      
      console.log('Found file for backlink', { path: file.path });
      
      // Parse existing front matter
      const frontMatter = parseFrontMatter(file.content);
      if (!frontMatter) {
        console.warn(`Could not parse front matter for: ${linkedItem.sb_id}`);
        continue;
      }
      
      console.log('Parsed front matter', { type: frontMatter.type, existingLinks: frontMatter.links?.length || 0 });
      
      // Add backlink if not already present
      const backlink = `[[${newItemSbId}]]`;
      const existingLinks = frontMatter.links || [];
      if (!existingLinks.includes(backlink)) {
        // Build updated front matter
        const updatedFrontMatter: FrontMatter = {
          id: frontMatter.id || linkedItem.sb_id,
          type: (frontMatter.type as 'idea' | 'decision' | 'project') || 'idea',
          title: frontMatter.title || linkedItem.title,
          created_at: frontMatter.created_at || new Date().toISOString(),
          tags: frontMatter.tags || [],
          links: [...existingLinks, backlink],
          updated_at: new Date().toISOString(),
        };
        
        // Update the file content
        let newContent = regenerateFileWithFrontMatter(file.content, updatedFrontMatter);
        
        // If the linked item is a project and we're adding an idea/decision, 
        // also add to the appropriate section in the body
        if (frontMatter.type === 'project' && newItemType && newItemTitle) {
          newContent = addToProjectSection(newContent, newItemType, newItemSbId, newItemTitle);
        }
        
        const parentCommitId = await getLatestCommitId(config);
        await writeFile(
          config,
          { path: file.path, content: newContent, mode: 'update' },
          `Add backlink to ${linkedItem.sb_id}`,
          parentCommitId
        );
      }
    } catch (error) {
      console.warn(`Failed to add backlink to ${linkedItem.sb_id}:`, error);
      // Continue with other backlinks
    }
  }
}

/**
 * Add an item to the appropriate section in a project file body
 * 
 * For ideas, adds to ## Ideas section
 * For decisions, adds to ## Decisions section
 */
function addToProjectSection(
  content: string,
  itemType: string,
  sbId: string,
  title: string
): string {
  // Determine which section to add to
  let sectionHeader: string;
  if (itemType === 'idea') {
    sectionHeader = '## Ideas';
  } else if (itemType === 'decision') {
    sectionHeader = '## Decisions';
  } else {
    // Only handle ideas and decisions for now
    return content;
  }
  
  const wikilink = `- [[${sbId}|${title}]]`;
  
  // Check if the wikilink already exists in the content
  if (content.includes(`[[${sbId}|`) || content.includes(`[[${sbId}]]`)) {
    return content;
  }
  
  // Find the section
  const sectionRegex = new RegExp(`(${sectionHeader}\\n)`, 'i');
  const sectionMatch = content.match(sectionRegex);
  
  if (sectionMatch && sectionMatch.index !== undefined) {
    // Section exists - add after the header
    const insertPos = sectionMatch.index + sectionMatch[0].length;
    return content.slice(0, insertPos) + wikilink + '\n' + content.slice(insertPos);
  } else {
    // Section doesn't exist - add it before the Source line or at end
    const sourceMatch = content.match(/\n---\nSource:/);
    const newSection = `\n${sectionHeader}\n${wikilink}\n`;
    
    if (sourceMatch && sourceMatch.index !== undefined) {
      return content.slice(0, sourceMatch.index) + newSection + content.slice(sourceMatch.index);
    } else {
      return content + newSection;
    }
  }
}

/**
 * Append related items section to content
 * 
 * Adds a "Related" section before the Source line with wikilinks to related items.
 */
function appendRelatedSection(
  content: string,
  related: Array<{ sbId: string; title: string; matchingTags: string[] }>
): string {
  if (related.length === 0) {
    return content;
  }

  // Find the Source line (usually at the end after ---)
  const sourceMatch = content.match(/\n---\nSource:/);
  
  const relatedLines: string[] = [
    '',
    '## Related',
    '',
  ];

  for (const item of related) {
    const wikilink = generateWikilink(item.sbId, item.title);
    const tagList = item.matchingTags.join(', ');
    relatedLines.push(`- ${wikilink} (${tagList})`);
  }

  relatedLines.push('');

  if (sourceMatch && sourceMatch.index !== undefined) {
    // Insert before the --- Source line
    const beforeSource = content.slice(0, sourceMatch.index);
    const sourceAndAfter = content.slice(sourceMatch.index);
    return beforeSource + relatedLines.join('\n') + sourceAndAfter;
  } else {
    // No source line found, append at end
    return content + relatedLines.join('\n');
  }
}

/**
 * Generate file_operations for a plan if missing
 * 
 * For idea/decision/project, generates the appropriate file path and content.
 * For tasks, returns empty array (tasks go to OmniFocus, not files).
 */
function ensureFileOperations(plan: ActionPlan): ActionPlan {
  // If file_operations already exists and is an array, return as-is
  if (Array.isArray(plan.file_operations) && plan.file_operations.length > 0) {
    return plan;
  }

  // Tasks don't need file operations
  if (plan.classification === 'task') {
    return { ...plan, file_operations: [] };
  }

  // For inbox, idea, decision, project - generate file operations
  const today = new Date().toISOString().split('T')[0];
  const slug = (plan.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);

  let path: string;
  let content = plan.content || `# ${plan.title}\n\n${plan.reasoning || ''}`;

  switch (plan.classification) {
    case 'inbox':
      // Inbox appends to daily file
      const time = new Date().toISOString().split('T')[1].substring(0, 5);
      path = `00-inbox/${today}.md`;
      content = `- ${time}: ${plan.content || plan.title}\n`;
      return {
        ...plan,
        file_operations: [{
          operation: 'append' as const,
          path,
          content,
        }],
      };

    case 'idea':
      path = `10-ideas/${today}__${slug}__PLACEHOLDER.md`;
      break;

    case 'decision':
      path = `20-decisions/${today}__${slug}__PLACEHOLDER.md`;
      break;

    case 'project':
      path = `30-projects/${today}__${slug}__PLACEHOLDER.md`;
      break;

    default:
      // Unknown classification - default to inbox
      path = `00-inbox/${today}.md`;
      const defaultTime = new Date().toISOString().split('T')[1].substring(0, 5);
      content = `- ${defaultTime}: ${plan.content || plan.title}\n`;
      return {
        ...plan,
        file_operations: [{
          operation: 'append' as const,
          path,
          content,
        }],
      };
  }

  return {
    ...plan,
    file_operations: [{
      operation: 'create' as const,
      path,
      content,
    }],
  };
}

/**
 * Execute CodeCommit file operations
 * 
 * Validates: Requirements 44.1, 44a.3
 */
async function executeCodeCommitOperations(
  config: KnowledgeStoreConfig,
  plan: ActionPlan,
  slackContext?: SlackContext
): Promise<{ commit: CommitResult | null; sbId: string | null; filePath: string | null; finalContent: string | null }> {
  // Ensure file_operations exists
  const normalizedPlan = ensureFileOperations(plan);
  
  if (normalizedPlan.file_operations.length === 0) {
    return { commit: null, sbId: null, filePath: null, finalContent: null };
  }

  let lastCommit: CommitResult | null = null;
  let generatedSbId: string | null = null;
  let primaryFilePath: string | null = null;
  let finalContent: string | null = null;

  for (const op of normalizedPlan.file_operations) {
    const parentCommitId = await getLatestCommitId(config);
    
    // Inject front matter for idea/decision/project classifications
    // Use op.content if available, otherwise fall back to top-level content
    let contentToWrite = op.content || normalizedPlan.content || '';
    let pathToWrite = op.path;
    
    if (requiresFrontMatter(normalizedPlan.classification) && op.operation === 'create') {
      // Build source metadata from slack context
      const source = slackContext ? {
        channelId: slackContext.channel_id,
        messageTs: slackContext.message_ts,
      } : undefined;
      
      // Get parent from linked_project if available
      const parent = normalizedPlan.linked_project?.sb_id;
      
      const { content: contentWithFrontMatter, sbId } = injectFrontMatter(
        contentToWrite,
        normalizedPlan.classification,
        normalizedPlan.title,
        source,
        normalizedPlan.linked_items,
        { 
          parent,
          summary: normalizedPlan.summary,  // LLM-generated
          tags: normalizedPlan.tags,        // LLM-generated
        }
      );
      contentToWrite = contentWithFrontMatter;
      generatedSbId = sbId;
      finalContent = contentWithFrontMatter;  // Save for sync
      
      // Replace any sb-xxxxxxx placeholder pattern in path with actual SB_ID
      // Handles: PLACEHOLDER, sb-xxxxxxx, sb-zzzzzz, or any sb-[a-z0-9]+ pattern
      pathToWrite = op.path.replace(/(?:PLACEHOLDER|sb-[a-z0-9]+)(?=\.md$)/, sbId);
      primaryFilePath = pathToWrite;
      
      // Find and append related items by tags
      const tags = extractTags(op.content, normalizedPlan.title);
      if (tags.length > 0) {
        const related = await findRelatedByTags(config, tags, pathToWrite);
        if (related.length > 0) {
          contentToWrite = appendRelatedSection(contentToWrite, related);
        }
      }
    }

    if (op.operation === 'append') {
      lastCommit = await appendToFile(
        config,
        pathToWrite,
        contentToWrite,
        `${normalizedPlan.classification}: ${normalizedPlan.title}`
      );
    } else {
      lastCommit = await writeFile(
        config,
        { path: pathToWrite, content: contentToWrite, mode: op.operation },
        `${normalizedPlan.classification}: ${normalizedPlan.title}`,
        parentCommitId
      );
      
      // Add backlinks to linked items after creating new item
      // Validates: Requirement 4.1 (bidirectional linking)
      if (generatedSbId && normalizedPlan.linked_items && normalizedPlan.linked_items.length > 0) {
        console.log('Adding backlinks', {
          newItemSbId: generatedSbId,
          linkedItemsCount: normalizedPlan.linked_items.length,
          classification: normalizedPlan.classification,
          title: normalizedPlan.title,
        });
        await addBacklinks(
          config, 
          generatedSbId, 
          normalizedPlan.linked_items,
          normalizedPlan.classification || undefined,
          normalizedPlan.title || undefined
        );
      }
    }
  }

  return { commit: lastCommit, sbId: generatedSbId, filePath: primaryFilePath, finalContent };
}

/**
 * Log task to daily inbox file
 * 
 * Creates an audit trail of all tasks captured, even though they're sent to OmniFocus.
 * Preserves full context - nothing gets lost.
 * 
 * Format:
 * - HH:MM: [task] <title> (Project: <project name>)
 *   > Full context preserved here
 */
async function logTaskToInbox(
  config: KnowledgeStoreConfig,
  plan: ActionPlan
): Promise<CommitResult | null> {
  if (plan.classification !== 'task') {
    return null;
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const time = now.toISOString().split('T')[1].substring(0, 5); // HH:MM
  const inboxPath = `00-inbox/${today}.md`;
  
  const taskTitle = plan.task_details?.title || plan.title || 'Untitled task';
  const projectSuffix = plan.linked_project?.title ? ` (Project: ${plan.linked_project.title})` : '';
  
  // Build entry with full context preserved
  const lines: string[] = [];
  lines.push(`- ${time}: [task] ${taskTitle}${projectSuffix}`);
  
  // Include task context if present (contains extracted details like contacts, numbers)
  const context = plan.task_details?.context || plan.content;
  if (context && context !== taskTitle) {
    // Indent context as a blockquote for readability
    const contextLines = context.split('\n').map(line => `  > ${line}`);
    lines.push(...contextLines);
  }
  
  const entry = lines.join('\n') + '\n';

  try {
    const commit = await appendToFile(
      config,
      inboxPath,
      entry,
      `Log task: ${taskTitle}`
    );
    return commit;
  } catch (error) {
    // Log but don't fail - inbox logging is supplementary
    console.warn('Failed to log task to inbox', { error });
    return null;
  }
}

/**
 * Send task email via SES with retry
 * 
 * Validates: Requirements 50.4, 50.5
 */
async function sendTaskEmail(
  config: ExecutorConfig,
  plan: ActionPlan
): Promise<string | null> {
  if (plan.classification !== 'task') {
    return null;
  }

  // Construct task_details from plan if missing
  const taskDetails = plan.task_details || {
    title: plan.title,
    context: plan.content || plan.title,
  };

  if (config.emailMode === 'log') {
    console.log('Email mode is log, skipping SES send', {
      subject: taskDetails.title,
      context: taskDetails.context,
      linkedProject: plan.linked_project?.sb_id,
    });
    return 'log-mode-skipped';
  }

  const mailDropEmail = await getMailDropEmail(config.mailDropParam);

  // Build email body with optional project link
  const bodyLines: string[] = [];
  if (taskDetails.context) {
    bodyLines.push(taskDetails.context);
    bodyLines.push('');
  }
  
  // Add project info if present (for manual association in OmniFocus)
  if (plan.linked_project?.title) {
    bodyLines.push(`Project: ${plan.linked_project.title}`);
    bodyLines.push('');
  }
  
  // Add linked items if present (cross-item linking)
  // Validates: Requirements 8.2, 8.3, 8.4, 8.5
  if (plan.linked_items && plan.linked_items.length > 0) {
    const titles = plan.linked_items.map(item => item.title).join(', ');
    bodyLines.push(`Related: ${titles}`);
    bodyLines.push('');
  }
  
  bodyLines.push('---');
  
  // Add project link metadata if present (task-project linking)
  if (plan.linked_project?.sb_id) {
    bodyLines.push(`SB-Project: ${plan.linked_project.sb_id}`);
  }
  
  // Add linked item SB_IDs (cross-item linking)
  if (plan.linked_items && plan.linked_items.length > 0) {
    const sbIds = plan.linked_items.map(item => item.sb_id).join(', ');
    bodyLines.push(`SB-Links: ${sbIds}`);
  }
  
  bodyLines.push('SB-Source: maildrop');
  bodyLines.push(`Source: Slack DM`);

  const emailBody = bodyLines.join('\n');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await sesClient.send(
        new SendEmailCommand({
          Source: config.senderEmail,
          Destination: {
            ToAddresses: [mailDropEmail],
          },
          Message: {
            Subject: {
              Data: taskDetails.title,
              Charset: 'UTF-8',
            },
            Body: {
              Text: {
                Data: emailBody,
                Charset: 'UTF-8',
              },
            },
          },
        })
      );

      return response.MessageId || null;
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number }; retryAfterSeconds?: number };
      
      // Check for throttling
      if (err.name === 'Throttling' || err.$metadata?.httpStatusCode === 429) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = calculateBackoff(attempt, err.retryAfterSeconds);
          console.warn('SES throttled, retrying', { attempt, delay });
          await sleep(delay);
          continue;
        }
      }
      throw error;
    }
  }

  return null;
}

/**
 * Send project setup email via SES
 * 
 * Creates a task in OmniFocus that can trigger automation to create/link a project.
 * Email body contains structured metadata for OmniFocus Automation to parse.
 */
async function sendProjectEmail(
  config: ExecutorConfig,
  plan: ActionPlan,
  sbId: string,
  filePath: string
): Promise<string | null> {
  if (plan.classification !== 'project') {
    return null;
  }

  if (config.emailMode === 'log') {
    console.log('Email mode is log, skipping project SES send', {
      subject: `Setup project: ${plan.title}`,
      sbId,
      filePath,
    });
    return 'log-mode-skipped';
  }

  const mailDropEmail = await getMailDropEmail(config.mailDropParam);

  // Structured body for OmniFocus Automation to parse
  const body = `--
SB_ID: ${sbId}
Type: project
File: ${filePath}
--

${plan.content || plan.title}

---
This task was auto-generated to create or link an OmniFocus project.
Use the SB_ID to maintain continuity between knowledge and execution.`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await sesClient.send(
        new SendEmailCommand({
          Source: config.senderEmail,
          Destination: {
            ToAddresses: [mailDropEmail],
          },
          Message: {
            Subject: {
              Data: `Setup project: ${plan.title}`,
              Charset: 'UTF-8',
            },
            Body: {
              Text: {
                Data: body,
                Charset: 'UTF-8',
              },
            },
          },
        })
      );

      return response.MessageId || null;
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number }; retryAfterSeconds?: number };
      
      if (err.name === 'Throttling' || err.$metadata?.httpStatusCode === 429) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = calculateBackoff(attempt, err.retryAfterSeconds);
          console.warn('SES throttled, retrying', { attempt, delay });
          await sleep(delay);
          continue;
        }
      }
      throw error;
    }
  }

  return null;
}

/**
 * Send Slack reply with retry
 * 
 * Validates: Requirements 50.1, 50.2, 50.3
 */
async function sendSlackReply(
  config: ExecutorConfig,
  slackContext: SlackContext,
  message: string
): Promise<string | null> {
  const botToken = await getBotToken(config.slackBotTokenParam);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: slackContext.channel_id,
          text: message,
          thread_ts: slackContext.message_ts,
        }),
      });

      // Check for rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
        if (attempt < MAX_RETRIES - 1) {
          const delay = calculateBackoff(attempt, retryAfter);
          console.warn('Slack rate limited, retrying', { attempt, delay });
          await sleep(delay);
          continue;
        }
        throw new Error('Slack rate limit exceeded');
      }

      const data = await response.json() as { ok: boolean; ts?: string; error?: string };

      if (!data.ok) {
        throw new Error(`Slack API error: ${data.error}`);
      }

      return data.ts || null;
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) {
        throw error;
      }
      await sleep(calculateBackoff(attempt));
    }
  }

  return null;
}

/**
 * Format confirmation reply message
 * 
 * Validates: Requirements 6.1, 6.2, 6.3 (cross-item linking display)
 */
function formatConfirmationReply(
  plan: ActionPlan,
  commitId: string | null,
  emailSent: boolean,
  projectEmailSent: boolean = false
): string {
  const lines: string[] = [];

  if (plan.classification === 'task' && emailSent) {
    const taskTitle = plan.task_details?.title || plan.title;
    lines.push(`Captured as *${plan.classification}*`);
    
    // Show linked project if present
    if (plan.linked_project) {
      lines.push(`Task sent to OmniFocus, linked to project: ${plan.linked_project.title} (${plan.linked_project.sb_id})`);
    } else {
      lines.push(`Task sent to OmniFocus: "${taskTitle}"`);
    }
    
    // Show linked items if present (cross-item linking)
    if (plan.linked_items && plan.linked_items.length > 0) {
      const linkedText = plan.linked_items
        .map(item => `${item.title} ([[${item.sb_id}]])`)
        .join(', ');
      lines.push(`Linked to: ${linkedText}`);
    }
    // No fix hint for tasks - they're emails, not commits
  } else if (plan.classification === 'project') {
    lines.push(`Captured as *${plan.classification}*`);
    
    const fileOps = plan.file_operations || [];
    if (fileOps.length > 0) {
      const files = fileOps.map((op) => op.path).join(', ');
      lines.push(`Files: ${files}`);
    }

    if (commitId) {
      lines.push(`Commit: \`${commitId.substring(0, 7)}\``);
    }

    if (projectEmailSent) {
      lines.push(`Project setup task sent to OmniFocus`);
    }
    
    // Show linked items if present (cross-item linking)
    if (plan.linked_items && plan.linked_items.length > 0) {
      const linkedText = plan.linked_items
        .map(item => `${item.title} ([[${item.sb_id}]])`)
        .join(', ');
      lines.push(`Linked to: ${linkedText}`);
    }

    lines.push('');
    lines.push('Reply `fix: <instruction>` to correct.');
  } else {
    lines.push(`Captured as *${plan.classification}*`);
    
    const fileOps = plan.file_operations || [];
    if (fileOps.length > 0) {
      const files = fileOps.map((op) => op.path).join(', ');
      lines.push(`Files: ${files}`);
    }

    if (commitId) {
      lines.push(`Commit: \`${commitId.substring(0, 7)}\``);
    }
    
    // Show linked items if present (cross-item linking)
    if (plan.linked_items && plan.linked_items.length > 0) {
      const linkedText = plan.linked_items
        .map(item => `${item.title} ([[${item.sb_id}]])`)
        .join(', ');
      lines.push(`Linked to: ${linkedText}`);
    }

    lines.push('');
    lines.push('Reply `fix: <instruction>` to correct.');
  }

  return lines.join('\n');
}

/**
 * Format error reply message
 */
function formatErrorReply(error: string, validationErrors?: string[]): string {
  const lines = ["I couldn't process that message. Please try rephrasing."];

  if (validationErrors && validationErrors.length > 0) {
    lines.push('');
    lines.push(`Errors: ${validationErrors.join(', ')}`);
  } else if (error) {
    lines.push('');
    lines.push(`Error: ${error}`);
  }

  return lines.join('\n');
}

/**
 * Execute Action Plan with side effects
 * 
 * Validates: Requirements 44.1, 44.2, 44a.3, 44b.2, 44b.3, 44c.3
 * 
 * @param skipSlackReply - If true, skip sending Slack reply (used for multi-item processing)
 */
export async function executeActionPlan(
  config: ExecutorConfig,
  eventId: string,
  plan: ActionPlan,
  slackContext: SlackContext,
  promptMetadata?: SystemPromptMetadata,
  skipSlackReply: boolean = false
): Promise<ExecutionResult> {
  const completedSteps: CompletedSteps = { codecommit: false, ses: false, slack: false };
  const actions: ReceiptAction[] = [];

  // Validate Action Plan first
  const validation = validateActionPlan(plan);
  if (!validation.valid) {
    // Send error reply to Slack
    const errorMessage = formatErrorReply(
      'Invalid Action Plan',
      validation.errors.map((e) => `${e.field}: ${e.message}`)
    );

    try {
      await sendSlackReply(config, slackContext, errorMessage);
      completedSteps.slack = true;
    } catch (error) {
      console.error('Failed to send error reply', { error });
    }

    // Create failure receipt
    const receipt = createReceipt(
      eventId,
      slackContext,
      plan.classification || 'inbox',
      plan.confidence || 0,
      actions,
      [],
      null,
      'Validation failed',
      {
        validationErrors: validation.errors.map((e) => `${e.field}: ${e.message}`),
        promptCommitId: promptMetadata?.commitId,
        promptSha256: promptMetadata?.sha256,
      }
    );

    try {
      await appendReceipt(config.knowledgeStore, receipt);
    } catch (error) {
      console.error('Failed to write failure receipt', { error });
    }

    return {
      success: false,
      validationErrors: validation.errors.map((e) => `${e.field}: ${e.message}`),
      completedSteps,
    };
  }

  // Check for partial failure recovery
  const priorSteps = await getCompletedSteps(config.idempotency, eventId);

  let commitResult: CommitResult | null = null;
  let generatedSbId: string | null = null;
  let primaryFilePath: string | null = null;
  let finalContent: string | null = null;
  let emailMessageId: string | null = null;
  let projectEmailId: string | null = null;
  let slackReplyTs: string | null = null;

  try {
    // Step 1: CodeCommit (if not already completed)
    if (!priorSteps.codecommit) {
      await updateExecutionState(config.idempotency, eventId, {
        status: 'EXECUTING',
        codecommit_status: 'IN_PROGRESS',
      });

      const ccResult = await executeCodeCommitOperations(config.knowledgeStore, plan, slackContext);
      commitResult = ccResult.commit;
      generatedSbId = ccResult.sbId;
      primaryFilePath = ccResult.filePath;
      finalContent = ccResult.finalContent;
      completedSteps.codecommit = true;

      await updateExecutionState(config.idempotency, eventId, {
        codecommit_status: 'SUCCEEDED',
        commit_id: commitResult?.commitId,
      });

      actions.push({
        type: 'commit',
        status: 'success',
        details: { commitId: commitResult?.commitId, files: (plan.file_operations || []).map((op) => op.path) },
      });
    } else {
      completedSteps.codecommit = true;
      actions.push({ type: 'commit', status: 'skipped', details: { reason: 'already completed' } });
    }

    // Step 2: SES for tasks (if task and not already completed)
    if (plan.classification === 'task' && !priorSteps.ses) {
      await updateExecutionState(config.idempotency, eventId, {
        ses_status: 'IN_PROGRESS',
      });

      // Log task to inbox for audit trail
      const inboxCommit = await logTaskToInbox(config.knowledgeStore, plan);
      if (inboxCommit) {
        actions.push({
          type: 'commit',
          status: 'success',
          details: { commitId: inboxCommit.commitId, files: [`00-inbox/${new Date().toISOString().split('T')[0]}.md`] },
        });
      }

      emailMessageId = await sendTaskEmail(config, plan);
      completedSteps.ses = true;

      await updateExecutionState(config.idempotency, eventId, {
        ses_status: 'SUCCEEDED',
      });

      actions.push({
        type: 'email',
        status: 'success',
        details: { messageId: emailMessageId },
      });
    } else if (plan.classification === 'project' && generatedSbId && primaryFilePath && !priorSteps.ses) {
      // Step 2b: SES for projects - send setup task to OmniFocus
      await updateExecutionState(config.idempotency, eventId, {
        ses_status: 'IN_PROGRESS',
      });

      projectEmailId = await sendProjectEmail(config, plan, generatedSbId, primaryFilePath);
      completedSteps.ses = true;

      await updateExecutionState(config.idempotency, eventId, {
        ses_status: 'SUCCEEDED',
      });

      actions.push({
        type: 'email',
        status: 'success',
        details: { messageId: projectEmailId, type: 'project_setup' },
      });
    } else if (plan.classification !== 'task' && plan.classification !== 'project') {
      completedSteps.ses = true;
      actions.push({ type: 'email', status: 'skipped', details: { reason: 'not a task or project' } });
    } else {
      completedSteps.ses = true;
      actions.push({ type: 'email', status: 'skipped', details: { reason: 'already completed' } });
    }

    // Step 3: Slack reply (if not already completed and not skipped)
    if (!priorSteps.slack && !skipSlackReply) {
      await updateExecutionState(config.idempotency, eventId, {
        slack_status: 'IN_PROGRESS',
      });

      const replyMessage = formatConfirmationReply(
        plan,
        commitResult?.commitId || null,
        !!emailMessageId,
        !!projectEmailId
      );
      slackReplyTs = await sendSlackReply(config, slackContext, replyMessage);
      completedSteps.slack = true;

      await updateExecutionState(config.idempotency, eventId, {
        slack_status: 'SUCCEEDED',
      });

      actions.push({
        type: 'slack_reply',
        status: 'success',
        details: { ts: slackReplyTs },
      });
    } else if (skipSlackReply) {
      completedSteps.slack = true;
      actions.push({ type: 'slack_reply', status: 'skipped', details: { reason: 'multi-item processing' } });
    } else {
      completedSteps.slack = true;
      actions.push({ type: 'slack_reply', status: 'skipped', details: { reason: 'already completed' } });
    }

    // Write receipt
    const receipt = createReceipt(
      eventId,
      slackContext,
      plan.classification || 'inbox',
      plan.confidence,
      actions,
      (plan.file_operations || []).map((op) => op.path),
      commitResult?.commitId || null,
      plan.title,
      {
        promptCommitId: promptMetadata?.commitId,
        promptSha256: promptMetadata?.sha256,
      }
    );

    const receiptResult = await appendReceipt(config.knowledgeStore, receipt);

    // Use actual file path (with real sb_id) instead of placeholder path from plan
    const actualFilesModified = primaryFilePath 
      ? [primaryFilePath] 
      : (plan.file_operations || []).map((op) => op.path);

    // Get final content for sync (only available for items with front matter)
    const fileContents = finalContent ? [finalContent] : undefined;

    return {
      success: true,
      commitId: commitResult?.commitId,
      receiptCommitId: receiptResult.commitId,
      slackReplyTs: slackReplyTs || undefined,
      emailMessageId: emailMessageId || undefined,
      filesModified: actualFilesModified,
      fileContents,
      generatedSbId: generatedSbId || undefined,
      completedSteps,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Execution failed', { eventId, error: errorMessage, completedSteps });

    // Mark partial failure
    await markPartialFailure(config.idempotency, eventId, errorMessage, completedSteps);

    // Try to send error reply if Slack step not completed
    if (!completedSteps.slack) {
      try {
        await sendSlackReply(config, slackContext, formatErrorReply(errorMessage));
      } catch {
        // Ignore error reply failure
      }
    }

    return {
      success: false,
      error: errorMessage,
      completedSteps,
    };
  }
}
