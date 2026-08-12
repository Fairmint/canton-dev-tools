/** Shared filesystem helpers for DAML→JS bundling / root-index merge. */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function createDirectoryIfNotExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function copyFile(src: string, dest: string): void {
  createDirectoryIfNotExists(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

export function copyDirectory(src: string, dest: string): void {
  if (!fs.existsSync(src)) {
    return;
  }
  createDirectoryIfNotExists(dest);
  for (const item of fs.readdirSync(src)) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

export function removeDirectoryIfExists(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

export function getImmediateChildDirs(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function createNamespaceIndexDts(childNamespaces: string[]): string {
  return `${childNamespaces
    .map((childNamespace) => `export * as ${childNamespace} from './${childNamespace}';`)
    .join('\n')}
`;
}

export function writeNamespaceIndexFiles(dirPath: string, childNamespaces: string[]): void {
  if (childNamespaces.length === 0) {
    return;
  }
  createDirectoryIfNotExists(dirPath);
  const indexJs = `"use strict";
/* eslint-disable-next-line no-unused-vars */
function __export(m) {
/* eslint-disable-next-line no-prototype-builtins */
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
${childNamespaces
  .map(
    (childNamespace) =>
      `var ${childNamespace} = require('./${childNamespace}');\nexports.${childNamespace} = ${childNamespace};`
  )
  .join('\n')}
`;
  fs.writeFileSync(path.join(dirPath, 'index.js'), indexJs);
  fs.writeFileSync(path.join(dirPath, 'index.d.ts'), createNamespaceIndexDts(childNamespaces));
}

export function ensureBundledSpliceNamespaceIndexes(targetDir: string): void {
  const spliceDir = path.join(targetDir, 'lib/Splice');
  const apiDir = path.join(spliceDir, 'Api');
  const tokenDir = path.join(apiDir, 'Token');

  const tokenNamespaces = getImmediateChildDirs(tokenDir);
  if (tokenNamespaces.length > 0) {
    writeNamespaceIndexFiles(tokenDir, tokenNamespaces);
  }

  const apiNamespaces = getImmediateChildDirs(apiDir);
  if (apiNamespaces.length > 0) {
    writeNamespaceIndexFiles(apiDir, apiNamespaces);
  }

  const spliceNamespaces = getImmediateChildDirs(spliceDir);
  if (spliceNamespaces.length > 0) {
    writeNamespaceIndexFiles(spliceDir, spliceNamespaces);
  }
}

export function ensureBundledDANamespaceIndexes(targetDir: string): void {
  const daDir = path.join(targetDir, 'lib/DA');
  const daNamespaces = getImmediateChildDirs(daDir);
  if (daNamespaces.length > 0) {
    writeNamespaceIndexFiles(daDir, daNamespaces);
  }
}

export function normalizeImportTarget(importPath: string): string {
  return path
    .normalize(importPath)
    .replace(/(\.d\.ts|\.js)$/, '')
    .replace(/[/\\]index$/, '');
}
