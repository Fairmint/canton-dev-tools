import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * Mirrors scripts/check-package-artifacts.ts forbiddenPackagePathReason so unit CI
 * catches regressions without invoking npm pack on every jest run.
 */
function forbiddenPackagePathReason(packagePath: string): string | null {
  if (packagePath.endsWith('.dar')) return 'DAML DAR files are not runtime package artifacts';
  if (packagePath === 'fixtures' || packagePath.startsWith('fixtures/')) {
    return 'internal fixtures (including DAR lifecycle sources) must not be published';
  }
  if (packagePath === 'internal' || packagePath.startsWith('internal/')) {
    return 'internal CI-only assets must not be published';
  }
  if (packagePath === 'libs' || packagePath.startsWith('libs/')) {
    return 'submodules under libs/ must not be published';
  }
  if (packagePath === 'node_modules' || packagePath.startsWith('node_modules/')) {
    return 'node_modules must not be published';
  }
  if (packagePath === 'core' || packagePath.startsWith('core.')) {
    return 'crash dumps must not be published';
  }
  return null;
}

describe('package artifact policy', (): void => {
  it('publishes only bin, scripts/localnet-cloud.sh, and dist/**', (): void => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };

    expect(pkg.files).toEqual(['bin/canton-dev-tools', 'scripts/localnet-cloud.sh', 'dist/**']);
    expect(pkg.files.join('\n')).not.toMatch(/fixtures|internal|\.dar/);
  });

  it('forbids shipping fixtures and DAR lifecycle paths', (): void => {
    expect(forbiddenPackagePathReason('fixtures/dar-lifecycle/daml.yaml')).toMatch(/fixtures/);
    expect(
      forbiddenPackagePathReason('fixtures/dar-lifecycle/.daml/dist/DarLifecycle-0.0.1.dar')
    ).toMatch(/DAR/);
    expect(
      forbiddenPackagePathReason('fixtures/splice-test-token-v2/splice-test-token-v2-1.0.0.dar')
    ).toMatch(/DAR/);
    expect(forbiddenPackagePathReason('fixtures/splice-test-token-v2/README.md')).toMatch(
      /fixtures/
    );
    expect(forbiddenPackagePathReason('internal/daml-fixture/daml.yaml')).toMatch(/internal/);
    expect(forbiddenPackagePathReason('artifact.dar')).toMatch(/DAR/);
    expect(forbiddenPackagePathReason('bin/canton-dev-tools')).toBeNull();
    expect(forbiddenPackagePathReason('scripts/localnet-cloud.sh')).toBeNull();
    expect(forbiddenPackagePathReason('dist/index.js')).toBeNull();
  });

  it('keeps check-package-artifacts aligned with fixture exclusion policy', (): void => {
    const checker = readFileSync(resolve(REPO_ROOT, 'scripts/check-package-artifacts.ts'), 'utf8');
    expect(checker).toContain("packagePath === 'fixtures'");
    expect(checker).toContain("packagePath.startsWith('fixtures/')");
    expect(checker).toContain('DEFAULT_SCRIBE_VERSION');
    expect(checker).toContain('DEFAULT_PROTOCOL_VERSION');
  });
});
