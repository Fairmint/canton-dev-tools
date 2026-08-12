import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GeneratedOutputWalkOptions {
  ignoredDirs?: string[];
}

export interface GeneratedOutputTransformContext {
  filePath: string;
  isDts: boolean;
}

export interface GeneratedImportRewriteRule {
  importPaths: string[];
  resolveTarget: (filePath: string) => string;
  logLabel?: string;
}

export interface GeneratedOutputPairContents {
  js: string;
  dts: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDir(dirPath: string): string {
  return path.resolve(dirPath);
}

function isWithinDir(dirPath: string, candidatePath: string): boolean {
  const normalizedDir = normalizeDir(dirPath);
  const normalizedCandidate = normalizeDir(candidatePath);
  return (
    normalizedCandidate === normalizedDir ||
    normalizedCandidate.startsWith(`${normalizedDir}${path.sep}`)
  );
}

function normalizeRelativeImport(fromFile: string, toTarget: string): string {
  let relativePath = path.relative(path.dirname(fromFile), toTarget).replace(/\\/g, '/');
  if (relativePath === '') {
    relativePath = '.';
  }
  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    relativePath = `./${relativePath}`;
  }
  return relativePath;
}

function replaceImportPath(
  source: string,
  importPath: string,
  relativePath: string,
  isDts: boolean
): string {
  const escapedImportPath = escapeRegExp(importPath);
  // Preserve whichever quote style the generated import used.
  if (isDts) {
    return source.replace(
      new RegExp(`from (['"])${escapedImportPath}\\1;`, 'g'),
      `from $1${relativePath}$1;`
    );
  }

  return source.replace(
    new RegExp(`require\\((['"])${escapedImportPath}\\1\\)`, 'g'),
    `require($1${relativePath}$1)`
  );
}

export function hasGeneratedOutputPair(dirPath: string, baseName: string): boolean {
  const js = path.join(dirPath, `${baseName}.js`);
  const dts = path.join(dirPath, `${baseName}.d.ts`);
  return fs.existsSync(js) && fs.existsSync(dts);
}

export function writeGeneratedOutputPair(
  dirPath: string,
  baseName: string,
  contents: GeneratedOutputPairContents
): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, `${baseName}.js`), contents.js);
  fs.writeFileSync(path.join(dirPath, `${baseName}.d.ts`), contents.dts);
}

export function collectGeneratedOutputFiles(
  rootDir: string,
  options: GeneratedOutputWalkOptions = {}
): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const ignoredDirs = (options.ignoredDirs ?? []).map((dirPath) => normalizeDir(dirPath));
  const pendingDirs = [rootDir];
  const files: string[] = [];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (ignoredDirs.some((ignoredDir) => isWithinDir(ignoredDir, entryPath))) {
          continue;
        }
        pendingDirs.push(entryPath);
        continue;
      }

      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

export function findGeneratedOutputFilesContainingAny(
  rootDir: string,
  needles: readonly string[],
  options: GeneratedOutputWalkOptions = {}
): string[] {
  return collectGeneratedOutputFiles(rootDir, options).filter((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return needles.some((needle) => source.includes(needle));
  });
}

export function rewriteGeneratedOutputFiles(
  rootDir: string,
  transform: (source: string, context: GeneratedOutputTransformContext) => string,
  options: GeneratedOutputWalkOptions = {}
): number {
  let rewrittenCount = 0;

  for (const filePath of collectGeneratedOutputFiles(rootDir, options)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const next = transform(source, { filePath, isDts: filePath.endsWith('.d.ts') });

    if (next !== source) {
      fs.writeFileSync(filePath, next);
      rewrittenCount++;
    }
  }

  return rewrittenCount;
}

export function applyGeneratedImportRewrites(
  rootDir: string,
  rules: GeneratedImportRewriteRule[],
  options: GeneratedOutputWalkOptions = {}
): number {
  return rewriteGeneratedOutputFiles(
    rootDir,
    (source, context) => {
      let next = source;

      for (const rule of rules) {
        if (!rule.importPaths.some((importPath) => next.includes(importPath))) {
          continue;
        }

        const relativePath = normalizeRelativeImport(
          context.filePath,
          rule.resolveTarget(context.filePath)
        );
        const updated = rule.importPaths.reduce(
          (currentSource, importPath) =>
            replaceImportPath(currentSource, importPath, relativePath, context.isDts),
          next
        );

        if (updated !== next && rule.logLabel) {
          console.log(
            `  Updating ${path.relative(rootDir, context.filePath)} with ${rule.logLabel} path: ${relativePath}`
          );
        }

        next = updated;
      }

      return next;
    },
    options
  );
}
