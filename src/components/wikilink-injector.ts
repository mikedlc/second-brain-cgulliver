/**
 * Wikilink Injector — Functions for cross-referencing knowledge files
 *
 * Adds wikilinks to related files in new content and injects backlinks
 * into existing related files when new content is created.
 *
 * Validates: Requirements 9.1, 9.2, 9.3
 */

/**
 * Inject wikilinks for related files into content.
 *
 * Adds a "## Related" section at the end of the content containing
 * [[path]] wikilinks for each related file. If a "## Related" section
 * already exists, appends to it without duplicating links.
 *
 * @param content - The markdown content to inject wikilinks into
 * @param relatedFiles - Array of file paths to link to
 * @returns The content with wikilinks injected
 */
export function injectWikilinks(content: string, relatedFiles: string[]): string {
  if (relatedFiles.length === 0) {
    return content;
  }

  const relatedHeadingPattern = /^## Related\s*$/m;
  const existingMatch = content.match(relatedHeadingPattern);

  if (existingMatch) {
    // Find the position of the existing "## Related" section
    const headingIndex = content.indexOf(existingMatch[0]);
    const afterHeading = headingIndex + existingMatch[0].length;

    // Find the end of the Related section (next ## heading or end of content)
    const restAfterHeading = content.slice(afterHeading);
    const nextHeadingMatch = restAfterHeading.match(/\n## /);
    const sectionEnd = nextHeadingMatch
      ? afterHeading + nextHeadingMatch.index!
      : content.length;

    // Get existing section content to check for duplicates
    const existingSectionContent = content.slice(afterHeading, sectionEnd);

    // Filter out links that already exist
    const newLinks = relatedFiles.filter(
      (file) => !existingSectionContent.includes(`[[${file}]]`)
    );

    if (newLinks.length === 0) {
      return content;
    }

    // Build new links string
    const linksStr = newLinks.map((file) => `- [[${file}]]`).join('\n');

    // Insert before the next section (or at end)
    const before = content.slice(0, sectionEnd).trimEnd();
    const after = content.slice(sectionEnd);

    return `${before}\n${linksStr}\n${after}`;
  }

  // No existing "## Related" section — create one at the end
  const linksStr = relatedFiles.map((file) => `- [[${file}]]`).join('\n');
  const trimmedContent = content.trimEnd();

  return `${trimmedContent}\n\n## Related\n\n${linksStr}\n`;
}

/**
 * Inject a backlink into an existing file's content.
 *
 * Adds a backlink `[[newFilePath|newFileTitle]]` under a "## Backlinks" section
 * at the end of the content. If a "## Backlinks" section already exists,
 * appends to it. Does not add duplicate backlinks.
 *
 * @param existingContent - The current content of the file to add a backlink to
 * @param newFilePath - The path of the new file to link back to
 * @param newFileTitle - The title of the new file (used as display text)
 * @returns The content with the backlink injected
 */
export function injectBacklinks(
  existingContent: string,
  newFilePath: string,
  newFileTitle: string
): string {
  const backlinkEntry = `[[${newFilePath}|${newFileTitle}]]`;

  // Check if this backlink already exists anywhere in the content
  if (existingContent.includes(backlinkEntry)) {
    return existingContent;
  }

  const backlinksHeadingPattern = /^## Backlinks\s*$/m;
  const existingMatch = existingContent.match(backlinksHeadingPattern);

  if (existingMatch) {
    // Find the position of the existing "## Backlinks" section
    const headingIndex = existingContent.indexOf(existingMatch[0]);
    const afterHeading = headingIndex + existingMatch[0].length;

    // Find the end of the Backlinks section (next ## heading or end of content)
    const restAfterHeading = existingContent.slice(afterHeading);
    const nextHeadingMatch = restAfterHeading.match(/\n## /);
    const sectionEnd = nextHeadingMatch
      ? afterHeading + nextHeadingMatch.index!
      : existingContent.length;

    // Insert the new backlink at the end of the section
    const before = existingContent.slice(0, sectionEnd).trimEnd();
    const after = existingContent.slice(sectionEnd);

    return `${before}\n- ${backlinkEntry}\n${after}`;
  }

  // No existing "## Backlinks" section — create one at the end
  const trimmedContent = existingContent.trimEnd();

  return `${trimmedContent}\n\n## Backlinks\n\n- ${backlinkEntry}\n`;
}
