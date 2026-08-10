import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ACCOUNT_CONFIGS_CONTEXT_KEY,
  SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID,
  SPLICE_TEST_TOKEN_V2_PACKAGE_ID,
  SPLICE_TEST_TOKEN_V2_SHA256,
  TOKEN_RULES_CONTEXT_KEY,
  TOKEN_RULES_TEMPLATE_ID,
  TRANSFER_FACTORY_INTERFACE_ID,
  TRANSFER_INSTRUCTION_INTERFACE_ID,
  buildTokenRulesCreateCommand,
  buildTokenRulesOfferMintCommand,
  buildTransferFactoryTransferCommand,
  buildTransferInstructionAcceptCommand,
  encodeProviderLessExtraArgs,
  providerLessAccount,
  providerLessAccountConfig,
  spliceTestTokenV2Instrument,
} from '../../../src/testing';

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

describe('CIP-56 / CIP-112 Splice TestTokenV2 helpers', (): void => {
  it('pins the expected DAR SHA-256 and package id constants', (): void => {
    expect(SPLICE_TEST_TOKEN_V2_SHA256).toBe(
      '43fcf2fcf4e84861501a0c00e8550e2863e1aad553b1fb772ee8aa7bca7fd245'
    );
    expect(SPLICE_TEST_TOKEN_V2_PACKAGE_ID).toBe(
      'a38a96b6f46c14c599b2763bc4fc68911a9cada90f89c599a1401e8e3df685e1'
    );
    expect(SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID).toBe('X2');
  });

  it('documents that pack:check forbids fixtures/** and *.dar', (): void => {
    expect(forbiddenPackagePathReason('fixtures/splice-test-token-v2/README.md')).toMatch(
      /fixtures/
    );
    expect(
      forbiddenPackagePathReason('fixtures/splice-test-token-v2/splice-test-token-v2-1.0.0.dar')
    ).toMatch(/DAR/);
    expect(forbiddenPackagePathReason('splice-test-token-v2-1.0.0.dar')).toMatch(/DAR/);

    const checker = readFileSync(resolve(REPO_ROOT, 'scripts/check-package-artifacts.ts'), 'utf8');
    expect(checker).toContain("packagePath === 'fixtures'");
    expect(checker).toContain("packagePath.startsWith('fixtures/')");
    expect(checker).toContain(".endsWith('.dar')");

    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files.join('\n')).not.toMatch(/fixtures|\.dar/);
  });

  it('builds provider-less accounts and AccountConfig records', (): void => {
    expect(providerLessAccount('Alice::party')).toEqual({
      owner: 'Alice::party',
      provider: null,
      id: '',
    });
    expect(providerLessAccountConfig('Admin::party', 'Alice::party')).toEqual({
      admin: 'Admin::party',
      account: { owner: 'Alice::party', provider: null, id: '' },
      ownerConfig: { canInitiate: true, mustApprove: true },
      providerConfig: { canInitiate: false, mustApprove: false },
    });
    expect(spliceTestTokenV2Instrument('Admin::party')).toEqual({
      admin: 'Admin::party',
      id: 'X2',
    });
  });

  it('encodes ExtraArgs with TokenRules context for provider-less flows', (): void => {
    const extra = encodeProviderLessExtraArgs({
      tokenRulesContractId: 'cid-token-rules',
      meta: { reason: 'unit-test' },
    });
    expect(extra.context.values[TOKEN_RULES_CONTEXT_KEY]).toEqual({
      tag: 'AV_ContractId',
      value: 'cid-token-rules',
    });
    expect(extra.context.values[ACCOUNT_CONFIGS_CONTEXT_KEY]).toBeUndefined();
    expect(extra.meta.values).toEqual({ reason: 'unit-test' });
  });

  it('builds TokenRules create, OfferMint, TransferFactory_Transfer, and Accept commands', (): void => {
    const create = buildTokenRulesCreateCommand({ admin: 'Admin::party' });
    expect(create.templateId).toBe(TOKEN_RULES_TEMPLATE_ID);
    expect(create.createArgument).toEqual({ admin: 'Admin::party' });

    const mint = buildTokenRulesOfferMintCommand({
      tokenRulesContractId: 'cid-rules',
      admin: 'Admin::party',
      receiver: 'Alice::party',
      amount: '100.0',
      offeredAt: '2026-01-01T00:00:00Z',
    });
    expect(mint.choice).toBe('TokenRules_OfferMint');
    expect(mint.choiceArgument['instrumentId']).toEqual({
      admin: 'Admin::party',
      id: 'X2',
    });
    expect(mint.choiceArgument['receiver']).toEqual(providerLessAccount('Alice::party'));

    const transfer = buildTransferFactoryTransferCommand({
      transferFactoryContractId: 'cid-rules',
      admin: 'Admin::party',
      sender: 'Alice::party',
      receiver: 'Bob::party',
      amount: 10,
      inputHoldingCids: ['cid-holding-1'],
      requestedAt: '2026-01-01T00:00:00Z',
      executeBefore: '2026-01-08T00:00:00Z',
      extraArgs: encodeProviderLessExtraArgs({ tokenRulesContractId: 'cid-rules' }),
    });
    expect(transfer.templateId).toBe(TRANSFER_FACTORY_INTERFACE_ID);
    expect(transfer.choice).toBe('TransferFactory_Transfer');
    expect(transfer.choiceArgument['actors']).toEqual(['Alice::party']);
    expect((transfer.choiceArgument['transfer'] as { amount: string }).amount).toBe('10');

    const accept = buildTransferInstructionAcceptCommand({
      transferInstructionContractId: 'cid-instr',
      actors: ['Bob::party'],
      extraArgs: encodeProviderLessExtraArgs({ tokenRulesContractId: 'cid-rules' }),
    });
    expect(accept.templateId).toBe(TRANSFER_INSTRUCTION_INTERFACE_ID);
    expect(accept.choice).toBe('TransferInstruction_Accept');
    expect(accept.choiceArgument['actors']).toEqual(['Bob::party']);
  });
});
