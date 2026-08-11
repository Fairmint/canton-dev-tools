import {
  assertMainnetNotAhead,
  assertMainnetPromotionNotBehind,
  buildDeploymentTag,
  decideCandidateVersion,
  findDeploymentAnchor,
  listDeploymentTags,
  nextPatch,
  parseDeploymentTag,
  parseStrictSemver,
} from '../../../src/daml/dar-version-policy';
import {
  darLockEntriesEqual,
  type DarsLock,
  type DarsLockEntry,
} from '../../../src/daml/dar-utils';

function lock(entries: DarsLock['packages'] = {}): DarsLock {
  return { version: 1, packages: entries };
}

function marker(packageName: string, version: string, hash = 'a'): DarsLock['packages'] {
  return {
    [`${packageName}/${version}/${packageName}.dar`]: {
      sha256: hash,
      size: 1,
      sdkVersion: '3.5.1',
      uploadedAt: '2026-01-01T00:00:00.000Z',
      networks: ['mainnet'],
    },
  };
}

describe('dar-version-policy', (): void => {
  it('parses strict semver and rejects malformed versions', (): void => {
    expect(parseStrictSemver('0.0.1')).toEqual({ major: 0, minor: 0, patch: 1 });
    for (const malformed of ['1', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta', '-1.2.3']) {
      expect(parseStrictSemver(malformed)).toBeNull();
    }
    expect(nextPatch('1.2.9')).toBe('1.2.10');
  });

  it('builds and parses deployment tags', (): void => {
    const packageName = 'Example-v01';
    expect(buildDeploymentTag('devnet', packageName, '1.2.3')).toBe(
      'dar-deploy/devnet/Example-v01/v1.2.3'
    );
    expect(parseDeploymentTag('dar-deploy/mainnet/Example-v01/v1.2.3')).toEqual({
      name: 'dar-deploy/mainnet/Example-v01/v1.2.3',
      network: 'mainnet',
      packageName,
      version: '1.2.3',
    });
    expect(parseDeploymentTag('release/devnet/Example-v01/v9.9.9')).toBeNull();
    expect(parseDeploymentTag('dar-deploy/devnet/Example-v01/v1.2')).toBeNull();
  });

  it('finds deployment anchors from tags and legacy markers', (): void => {
    const packageName = 'Example-v01';
    expect(findDeploymentAnchor(packageName, [], lock())).toBeNull();
    expect(findDeploymentAnchor(packageName, [], lock(marker(packageName, '0.0.7')))).toEqual({
      version: '0.0.7',
      source: 'legacy-marker',
    });

    const tags = [
      'dar-deploy/devnet/Other/v9.9.9',
      'dar-deploy/mainnet/Example-v01/v0.0.8',
      'dar-deploy/devnet/Example-v01/v0.0.10',
      'dar-deploy/devnet/Example-v01/v0.0.9',
      'dar-deploy/devnet/Example-v01/not-semver',
    ];
    expect(
      listDeploymentTags(tags, packageName).map(({ network, version }) => `${network}:${version}`)
    ).toEqual(['mainnet:0.0.8', 'devnet:0.0.9', 'devnet:0.0.10']);
    expect(findDeploymentAnchor(packageName, tags, lock(marker(packageName, '8.0.0')))).toEqual({
      version: '0.0.10',
      source: 'devnet-tag',
    });
  });

  it('decides candidate versions', (): void => {
    expect(decideCandidateVersion('0.0.1', null, false)).toEqual({
      valid: true,
      kind: 'candidate',
      expectedVersion: '0.0.1',
    });
    expect(decideCandidateVersion('0.0.4', null, false).valid).toBe(false);
    expect(decideCandidateVersion('0.0.4', null, false, '0.0.4').kind).toBe('candidate');
    expect(decideCandidateVersion('0.0.5', null, false, '0.0.4').valid).toBe(false);
    const legacyAnchor = { version: '0.0.1', source: 'legacy-marker' } as const;
    expect(decideCandidateVersion('0.0.4', legacyAnchor, false, '0.0.4').kind).toBe('candidate');
    const anchor = { version: '1.2.9', source: 'devnet-tag' } as const;
    expect(decideCandidateVersion('1.2.9', anchor, true).kind).toBe('deployed');
    expect(decideCandidateVersion('1.2.9', anchor, false).valid).toBe(false);
    expect(decideCandidateVersion('1.2.10', anchor, false).kind).toBe('candidate');
    expect(decideCandidateVersion('1.2.11', anchor, false).valid).toBe(false);
    expect(decideCandidateVersion('1.2.11', anchor, false, '1.2.11').valid).toBe(false);
  });

  it('compares lock entries without depending on key order', (): void => {
    const entry: DarsLockEntry = {
      sha256: 'abc',
      size: 123,
      sdkVersion: '3.5.1',
      uploadedAt: '2026-01-01T00:00:00.000Z',
      networks: ['devnet', 'mainnet'],
    };
    const reorderedEntry = {
      networks: ['mainnet', 'devnet'],
      uploadedAt: entry.uploadedAt,
      sdkVersion: entry.sdkVersion,
      size: entry.size,
      sha256: entry.sha256,
    };
    expect(darLockEntriesEqual(entry, reorderedEntry)).toBe(true);
    expect(darLockEntriesEqual(entry, { ...reorderedEntry, sha256: 'different' })).toBe(false);
    expect(darLockEntriesEqual(entry, { ...reorderedEntry, networks: ['devnet', 'devnet'] })).toBe(
      false
    );
  });

  it('enforces mainnet / devnet tag ordering', (): void => {
    const packageName = 'Example-v01';
    expect(() =>
      findDeploymentAnchor(
        packageName,
        [],
        lock({
          ...marker(packageName, '2.0.0', 'hash-a'),
          [`${packageName}/2.0.0/alias.dar`]: {
            ...Object.values(marker(packageName, '2.0.0'))[0]!,
            sha256: 'hash-b',
          },
        })
      )
    ).toThrow(/multiple deployed legacy hashes/);
    expect(() =>
      assertMainnetNotAhead(packageName, ['dar-deploy/mainnet/Example-v01/v1.0.0'])
    ).toThrow(/newer than/);
    const mainnetTags = [
      'dar-deploy/devnet/Example-v01/v0.0.4',
      'dar-deploy/devnet/Example-v01/v0.0.6',
      'dar-deploy/mainnet/Example-v01/v0.0.5',
    ];
    expect(() => assertMainnetPromotionNotBehind(packageName, '0.0.5', mainnetTags)).not.toThrow();
    expect(() => assertMainnetPromotionNotBehind(packageName, '0.0.6', mainnetTags)).not.toThrow();
    expect(() => assertMainnetPromotionNotBehind(packageName, '0.0.4', mainnetTags)).toThrow(
      /older than latest Mainnet tag 0\.0\.5/
    );
  });
});
