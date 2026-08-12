import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  config: {
    localnet_quickstart_ref: string;
    localnet_splice_version: string;
    localnet_scribe_version: string;
    localnet_protocol_version: string;
  };
  bin: Record<string, string>;
};

const DEFAULT_QUICKSTART_REF = PACKAGE_JSON.config.localnet_quickstart_ref;
const DEFAULT_SPLICE_VERSION = PACKAGE_JSON.config.localnet_splice_version;
const DEFAULT_SCRIBE_VERSION = PACKAGE_JSON.config.localnet_scribe_version;
const DEFAULT_PROTOCOL_VERSION = PACKAGE_JSON.config.localnet_protocol_version;

function withPackagedBin(
  localnetScriptBody: string,
  run: (localnetBin: string, packageRoot: string) => string,
  options: { spliceVersionFile?: string } = {}
): string {
  const packageRoot = mkdtempSync(resolve(tmpdir(), 'canton-dev-tools-bin-'));
  const localnetBin = resolve(packageRoot, 'bin/canton-dev-tools');

  mkdirSync(resolve(packageRoot, 'bin'), { recursive: true });
  mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
  copyFileSync(resolve(REPO_ROOT, 'bin/canton-dev-tools'), localnetBin);
  chmodSync(localnetBin, 0o755);
  writeFileSync(resolve(packageRoot, 'scripts/localnet-cloud.sh'), localnetScriptBody);

  if (options.spliceVersionFile !== undefined) {
    mkdirSync(resolve(packageRoot, 'libs/splice'), { recursive: true });
    writeFileSync(resolve(packageRoot, 'libs/splice/VERSION'), options.spliceVersionFile);
  }

  try {
    return run(localnetBin, packageRoot);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
}

function runPackagedLocalnetWithVersion(version: string): string {
  return withPackagedBin(
    'printf "%s" "${CANTON_LOCALNET_SPLICE_VERSION}"\n',
    (localnetBin) =>
      execFileSync(localnetBin, ['diagnostics'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CANTON_LOCALNET_SPLICE_VERSION: '',
        },
      }),
    { spliceVersionFile: version }
  );
}

describe('canton-dev-tools pin ownership', (): void => {
  it('hardcodes package.json config pins in the packaged binary', (): void => {
    const localnetBin = readFileSync(resolve(REPO_ROOT, 'bin/canton-dev-tools'), 'utf8');

    expect(localnetBin).toContain(`DEFAULT_QUICKSTART_REF="${DEFAULT_QUICKSTART_REF}"`);
    expect(localnetBin).toContain(`DEFAULT_SPLICE_VERSION="${DEFAULT_SPLICE_VERSION}"`);
    expect(localnetBin).toContain(`DEFAULT_SCRIBE_VERSION="${DEFAULT_SCRIBE_VERSION}"`);
    expect(localnetBin).toContain(`DEFAULT_PROTOCOL_VERSION="${DEFAULT_PROTOCOL_VERSION}"`);
  });

  it('exports all four LocalNet pins for npx / direct binary invocations', (): void => {
    const output = withPackagedBin(
      [
        'printf "splice=%s\\n" "${CANTON_LOCALNET_SPLICE_VERSION}"',
        'printf "scribe=%s\\n" "${CANTON_LOCALNET_SCRIBE_VERSION}"',
        'printf "protocol=%s\\n" "${CANTON_LOCALNET_PROTOCOL_VERSION}"',
      ].join('\n'),
      (localnetBin, packageRoot) =>
        execFileSync(localnetBin, ['diagnostics'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            CANTON_LOCALNET_CACHE_DIR: resolve(packageRoot, 'cache'),
            HOME: resolve(packageRoot, 'home'),
            CANTON_LOCALNET_SPLICE_VERSION: '',
            CANTON_LOCALNET_SCRIBE_VERSION: '',
            CANTON_LOCALNET_PROTOCOL_VERSION: '',
          },
        })
    );

    expect(output.trim().split('\n')).toEqual([
      `splice=${DEFAULT_SPLICE_VERSION}`,
      `scribe=${DEFAULT_SCRIBE_VERSION}`,
      `protocol=${DEFAULT_PROTOCOL_VERSION}`,
    ]);
  });

  it('uses a non-empty trimmed packaged Splice version', (): void => {
    expect(runPackagedLocalnetWithVersion('  1.2.3 \n')).toBe('1.2.3');
  });

  it('falls back to the built-in Splice version when the packaged version is blank', (): void => {
    expect(runPackagedLocalnetWithVersion(' \n\t')).toBe(DEFAULT_SPLICE_VERSION);
  });
});

describe('canton-dev-tools command surface', (): void => {
  it('passes current LocalNet command names through without remapping', (): void => {
    for (const command of ['readiness', 'diagnostics', 'teardown'] as const) {
      const output = withPackagedBin('printf "%s" "$1"\n', (localnetBin, packageRoot) =>
        execFileSync(localnetBin, [command], {
          encoding: 'utf8',
          env: {
            ...process.env,
            CANTON_LOCALNET_CACHE_DIR: resolve(packageRoot, 'cache'),
            HOME: resolve(packageRoot, 'home'),
          },
        })
      );
      expect(output).toBe(command);
    }
  });

  it('passes start through after ensuring quickstart checkout', (): void => {
    const output = withPackagedBin('printf "%s" "$1"\n', (localnetBin, packageRoot) =>
      execFileSync(localnetBin, ['start'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CANTON_LOCALNET_CACHE_DIR: resolve(packageRoot, 'cache'),
          HOME: resolve(packageRoot, 'home'),
        },
      })
    );
    expect(output.trim().split('\n').at(-1)).toBe('start');
  });

  it('rejects legacy LocalNet aliases', (): void => {
    const result = withPackagedBin('printf "%s" "$1"\n', (localnetBin, packageRoot) => {
      try {
        execFileSync(localnetBin, ['smoke'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            CANTON_LOCALNET_CACHE_DIR: resolve(packageRoot, 'cache'),
            HOME: resolve(packageRoot, 'home'),
          },
        });
        return 'unexpected-success';
      } catch (error) {
        const err = error as { status?: number; stdout?: string };
        return `status=${err.status ?? 'unknown'}`;
      }
    });
    expect(result).toBe('status=1');
  });

  it('does not publish a canton-localnet bin alias', (): void => {
    expect(PACKAGE_JSON.bin).toEqual({ 'canton-dev-tools': 'bin/canton-dev-tools' });
    expect(PACKAGE_JSON.bin).not.toHaveProperty('canton-localnet');
  });

  it('does not document legacy aliases in --help', (): void => {
    const help = execFileSync(resolve(REPO_ROOT, 'bin/canton-dev-tools'), ['--help'], {
      encoding: 'utf8',
    });
    expect(help).not.toContain('Legacy');
    expect(help).not.toContain('canton-localnet');
    expect(help).not.toMatch(/\bsmoke\b/);
    expect(help).not.toMatch(/\bsetup\b/);
  });
});

describe('canton-dev-tools DAML command dispatch', (): void => {
  it('documents DAML package commands in --help', (): void => {
    const help = execFileSync(resolve(REPO_ROOT, 'bin/canton-dev-tools'), ['--help'], {
      encoding: 'utf8',
    });
    expect(help).toContain('prepare-build');
    expect(help).toContain('sync-splice-dars');
    expect(help).toContain('install-dpm-sdks');
    expect(help).toContain('codegen-js');
    expect(help).toContain('prepare-release');
    expect(help).toContain('collapse-manifest');
  });

  it('dispatches prepare-build to dist/cli.js', (): void => {
    const packageRoot = mkdtempSync(resolve(tmpdir(), 'canton-dev-tools-daml-cli-'));
    const localnetBin = resolve(packageRoot, 'bin/canton-dev-tools');

    mkdirSync(resolve(packageRoot, 'bin'), { recursive: true });
    mkdirSync(resolve(packageRoot, 'dist'), { recursive: true });
    mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
    copyFileSync(resolve(REPO_ROOT, 'bin/canton-dev-tools'), localnetBin);
    chmodSync(localnetBin, 0o755);
    writeFileSync(
      resolve(packageRoot, 'dist/cli.js'),
      '#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(" "));\n'
    );
    writeFileSync(resolve(packageRoot, 'scripts/localnet-cloud.sh'), 'true\n');
    writeFileSync(
      resolve(packageRoot, 'scripts/install-dpm-sdks.sh'),
      '#!/usr/bin/env bash\ntrue\n'
    );

    try {
      const output = execFileSync(localnetBin, ['prepare-build', '--root', '/tmp'], {
        encoding: 'utf8',
      });
      expect(output).toBe('prepare-build --root /tmp');

      const codegen = execFileSync(localnetBin, ['codegen-js', '--root', '/tmp'], {
        encoding: 'utf8',
      });
      expect(codegen).toBe('codegen-js --root /tmp');

      const release = execFileSync(localnetBin, ['prepare-release', '--changelog-repo', 'Fairmint/canton-assets'], {
        encoding: 'utf8',
      });
      expect(release).toBe('prepare-release --changelog-repo Fairmint/canton-assets');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
