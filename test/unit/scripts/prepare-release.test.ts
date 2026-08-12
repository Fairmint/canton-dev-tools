import { selectReleaseVersion, parseVersion, parseChangelogRepo } from '../../../scripts/prepare-release';

describe('selectReleaseVersion', (): void => {
  const withTakenVersions = (...versions: string[]) => {
    const takenVersions = new Set(versions);
    return (version: string): boolean => takenVersions.has(version);
  };

  it('publishes package.json exactly on first publish (npm 404)', (): void => {
    expect(selectReleaseVersion('0.1.0', null, withTakenVersions())).toBe('0.1.0');
  });

  it('publishes an intentionally advanced manifest version unchanged', (): void => {
    expect(selectReleaseVersion('0.6.0', '0.5.23', withTakenVersions('0.5.23'))).toBe('0.6.0');
  });

  it('resumes patch increments after the manifest version has been published', (): void => {
    expect(selectReleaseVersion('0.6.0', '0.6.0', withTakenVersions('0.6.0'))).toBe('0.6.1');
  });

  it('increments from a newer NPM baseline and skips unavailable versions', (): void => {
    expect(selectReleaseVersion('0.6.0', '0.6.2', withTakenVersions('0.6.2', '0.6.3'))).toBe(
      '0.6.4'
    );
  });

  it('does not reuse an advanced manifest version that is already tagged', (): void => {
    expect(selectReleaseVersion('0.6.0', '0.5.23', withTakenVersions('0.6.0'))).toBe('0.6.1');
  });

  it('patch-bumps when npm already has the package.json floor version', (): void => {
    // Mirrors the first post-bootstrap publish: npm has 0.1.0, manifest still says 0.1.0.
    expect(selectReleaseVersion('0.1.0', '0.1.0', withTakenVersions('0.1.0'))).toBe('0.1.1');
  });

  it('rejects non-exact semver before selecting a version', (): void => {
    expect(parseVersion('01.2.3')).toBeNull();
    expect(() => selectReleaseVersion('1..2', null, withTakenVersions())).toThrow(
      /Invalid version format/
    );
  });

  it('parses github repos whose names contain dots', (): void => {
    expect(parseChangelogRepo('https://github.com/acme/sdk.js.git')).toBe('acme/sdk.js');
  });
});
