#!/usr/bin/env node

/**
 * Thin wrapper kept for `npm run prepare-release` in this package.
 * Prefer `canton-dev-tools prepare-release` from consumer repos.
 */

import { prepareRelease } from '../src/prepare-release';

if (require.main === module) {
  try {
    prepareRelease({ rootDir: process.cwd() });
  } catch (error) {
    console.error('❌ Error preparing release:', (error as Error).message);
    process.exit(1);
  }
}

export { prepareRelease, selectReleaseVersion } from '../src/prepare-release';
