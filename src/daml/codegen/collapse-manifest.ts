/**
 * Collapse TypeScript package manifests by dropping map files and collapsing
 * `.js` / `.d.ts` pairs into extensionless entries.
 */

/** Pure helper: collapse a list of package file paths. */
export function collapseManifestLines(lines: readonly string[]): string[] {
  const normalized = lines.map((line) => line.trim()).filter((line) => line.length > 0);

  if (normalized.length === 0) {
    throw new Error('No files found for manifest generation');
  }

  const filesToKeep = new Set<string>();
  const collapsedFiles = new Set<string>();

  for (const line of normalized) {
    if (line.endsWith('.d.ts.map') || line.endsWith('.js.map')) {
      continue;
    }
    filesToKeep.add(line);
  }

  for (const file of filesToKeep) {
    if (file.endsWith('.d.ts') || file.endsWith('.js')) {
      collapsedFiles.add(file.replace(/\.(d\.ts|js)$/, ''));
    } else {
      collapsedFiles.add(file);
    }
  }

  return Array.from(collapsedFiles).sort();
}

/** CLI-style entry: read stdin lines and print the collapsed manifest. */
export function collapseManifestFromStdin(input: string): string {
  const lines = input.trim().split('\n');
  return collapseManifestLines(lines).join('\n');
}
