import type { DarsLock, DarsLockEntry } from './dar-utils';

export const DEPLOYMENT_NETWORKS = ['devnet', 'mainnet'] as const;
export type DeploymentNetwork = (typeof DEPLOYMENT_NETWORKS)[number];

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export interface DeploymentTag {
  name: string;
  network: DeploymentNetwork;
  packageName: string;
  version: string;
}

export interface DeploymentAnchor {
  version: string;
  source: 'devnet-tag' | 'legacy-marker';
}

export interface CandidateDecision {
  valid: boolean;
  kind: 'deployed' | 'candidate' | 'invalid';
  expectedVersion: string;
  message?: string;
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseStrictSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major, minor, patch };
}

export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseStrictSemver(left);
  const parsedRight = parseStrictSemver(right);
  if (!parsedLeft || !parsedRight)
    throw new Error(`Invalid semantic version comparison: ${left}, ${right}`);

  return (
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch
  );
}

export function nextPatch(version: string): string {
  const parsed = parseStrictSemver(version);
  if (!parsed || parsed.patch === Number.MAX_SAFE_INTEGER) {
    throw new Error(`Cannot increment invalid semantic version: ${version}`);
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function buildDeploymentTag(
  network: DeploymentNetwork,
  packageName: string,
  version: string
): string {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`Invalid package name for deployment tag: ${packageName}`);
  }
  if (!parseStrictSemver(version))
    throw new Error(`Invalid semantic version for deployment tag: ${version}`);
  return `dar-deploy/${network}/${packageName}/v${version}`;
}

export function parseDeploymentTag(name: string): DeploymentTag | null {
  const match = /^dar-deploy\/(devnet|mainnet)\/([^/]+)\/v(.+)$/.exec(name);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined)
    return null;
  if (!PACKAGE_NAME_PATTERN.test(match[2]) || !parseStrictSemver(match[3])) return null;
  return {
    name,
    network: match[1] as DeploymentNetwork,
    packageName: match[2],
    version: match[3],
  };
}

export function listDeploymentTags(tagNames: string[], packageName: string): DeploymentTag[] {
  return tagNames
    .map(parseDeploymentTag)
    .filter((tag): tag is DeploymentTag => tag?.packageName === packageName)
    .sort(
      (left, right) =>
        compareSemver(left.version, right.version) || left.network.localeCompare(right.network)
    );
}

export function last<T>(values: readonly T[]): T | undefined {
  return values.length === 0 ? undefined : values[values.length - 1];
}

export function getLockEntry(lock: DarsLock, key: string): DarsLockEntry | undefined {
  return Object.prototype.hasOwnProperty.call(lock.packages, key) ? lock.packages[key] : undefined;
}

function packageLockEntries(lock: DarsLock, packageName: string) {
  const prefix = `${packageName}/`;
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith(prefix) && entry.networks.length > 0)
    .map(([key, entry]) => ({ key, entry, version: key.slice(prefix.length).split('/')[0] ?? '' }))
    .filter(({ version }) => parseStrictSemver(version));
}

export function findDeploymentAnchor(
  packageName: string,
  tagNames: string[],
  legacyLock: DarsLock
): DeploymentAnchor | null {
  const tags = listDeploymentTags(tagNames, packageName);
  const devnetTags = tags.filter((tag) => tag.network === 'devnet');
  if (devnetTags.length > 0) {
    const latest = devnetTags[devnetTags.length - 1];
    if (!latest) return null;
    return { version: latest.version, source: 'devnet-tag' };
  }

  const legacyEntries = packageLockEntries(legacyLock, packageName);
  if (legacyEntries.length === 0) return null;

  const sortedVersions = legacyEntries.map(({ version }) => version).sort(compareSemver);
  const latestVersion = sortedVersions[sortedVersions.length - 1];
  if (!latestVersion) return null;
  const hashes = new Set(
    legacyEntries
      .filter(({ version }) => version === latestVersion)
      .map(({ entry }) => entry.sha256)
  );
  if (hashes.size > 1) {
    throw new Error(
      `${packageName} ${latestVersion} has multiple deployed legacy hashes; reconcile before continuing`
    );
  }
  return { version: latestVersion, source: 'legacy-marker' };
}

export function decideCandidateVersion(
  currentVersion: string,
  anchor: DeploymentAnchor | null,
  currentBytesMatchDeployed: boolean,
  migrationCandidateVersion?: string
): CandidateDecision {
  const defaultExpectedVersion = anchor ? nextPatch(anchor.version) : '0.0.1';
  const canReuseMigrationCandidate =
    anchor?.source !== 'devnet-tag' &&
    Boolean(migrationCandidateVersion && parseStrictSemver(migrationCandidateVersion)) &&
    (!anchor || compareSemver(migrationCandidateVersion!, anchor.version) > 0);
  const expectedVersion = canReuseMigrationCandidate
    ? migrationCandidateVersion!
    : defaultExpectedVersion;

  if (!parseStrictSemver(currentVersion)) {
    return {
      valid: false,
      kind: 'invalid',
      expectedVersion,
      message: `Current version is not strict semver: ${currentVersion}`,
    };
  }

  if (!anchor) {
    return currentVersion === expectedVersion
      ? { valid: true, kind: 'candidate', expectedVersion }
      : {
          valid: false,
          kind: 'invalid',
          expectedVersion,
          message: `No deployment evidence exists; expected candidate version ${expectedVersion}, got ${currentVersion}`,
        };
  }

  if (currentVersion === anchor.version && currentBytesMatchDeployed) {
    return { valid: true, kind: 'deployed', expectedVersion: anchor.version };
  }

  return currentVersion === expectedVersion
    ? { valid: true, kind: 'candidate', expectedVersion }
    : {
        valid: false,
        kind: 'invalid',
        expectedVersion,
        message:
          currentVersion === anchor.version
            ? `${currentVersion} is deployed and its bytes changed; use ${expectedVersion}`
            : `Expected ${expectedVersion}, exactly one patch above deployed ${anchor.version}; got ${currentVersion}`,
      };
}

export function assertMainnetNotAhead(packageName: string, tagNames: string[]): void {
  const tags = listDeploymentTags(tagNames, packageName);
  const devnetTags = tags.filter((tag) => tag.network === 'devnet');
  const mainnetTags = tags.filter((tag) => tag.network === 'mainnet');
  const latestDevnet = last(devnetTags);
  const latestMainnet = last(mainnetTags);
  if (
    latestMainnet &&
    (!latestDevnet || compareSemver(latestMainnet.version, latestDevnet.version) > 0)
  ) {
    throw new Error(
      `${packageName} Mainnet tag ${latestMainnet.version} is newer than its latest DevNet tag ${latestDevnet?.version ?? '(none)'}`
    );
  }
}

export function assertMainnetPromotionNotBehind(
  packageName: string,
  version: string,
  tagNames: string[]
): void {
  if (!parseStrictSemver(version)) throw new Error(`Invalid Mainnet promotion version: ${version}`);
  const latestMainnet = last(
    listDeploymentTags(tagNames, packageName).filter((tag) => tag.network === 'mainnet')
  );
  if (latestMainnet && compareSemver(version, latestMainnet.version) < 0) {
    throw new Error(
      `${packageName} Mainnet promotion ${version} is older than latest Mainnet tag ${latestMainnet.version}`
    );
  }
}
