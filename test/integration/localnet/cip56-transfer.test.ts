/**
 * CIP-56 / CIP-112 LocalNet transfer smoke (Splice TestTokenV2).
 *
 * Sequence (ENG-1635):
 *   1. fetch      — `npm run fixture:splice-test-token-v2:fetch`
 *   2. validate   — assert DAR SHA-256 + package id constants
 *   3. upload/vet — LOCALNET: upload DAR to Ledger JSON API + vet packages
 *   4. parties    — LOCALNET: allocate admin / alice / bob (createParty amount 0)
 *   5. TokenRules — create TokenRules for admin
 *   6. mint       — TokenRules_OfferMint + TransferInstruction_Accept (receiver)
 *   7. transfer   — TransferFactory_Transfer (V2) + TransferInstruction_Accept
 *   8. assert     — LOCALNET: receiver holdings / balances via listTokenStandardV2Holdings
 *
 * Unit-safe steps run without LocalNet. When Ledger is unreachable on :3975 the suite
 * skips (unit CI) rather than fail; `npm run localnet:cip56-transfer` fails closed via
 * `CANTON_CIP56_REQUIRE_LOCALNET=1`.
 */

import {
  SPLICE_TEST_TOKEN_V2_PACKAGE_ID,
  SPLICE_TEST_TOKEN_V2_SHA256,
  buildTokenRulesCreateCommand,
  buildTokenRulesOfferMintCommand,
  buildTransferFactoryTransferCommand,
  buildTransferInstructionAcceptCommand,
  encodeProviderLessExtraArgs,
  isSpliceTestTokenV2DarPresent,
  parseTransferInstructionResult,
  providerLessAccount,
  runCip56TransferSmoke,
  spliceTestTokenV2Instrument,
  toCreateCommand,
  toExerciseCommand,
} from '../../../src/testing';

const LEDGER_URL = process.env['FAIRMINT_TEST_LEDGER_API_URL'] ?? 'http://localhost:3975';
const PACKAGE_ROOT = process.cwd();
const REQUIRE_LOCALNET = process.env['CANTON_CIP56_REQUIRE_LOCALNET'] === '1';

async function isLedgerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${LEDGER_URL.replace(/\/$/, '')}/v2/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe('CIP-56 / CIP-112 Splice TestTokenV2 LocalNet transfer', (): void => {
  it('validates fixture constants and command builders without LocalNet', (): void => {
    expect(SPLICE_TEST_TOKEN_V2_SHA256).toHaveLength(64);
    expect(SPLICE_TEST_TOKEN_V2_PACKAGE_ID).toHaveLength(64);

    const create = buildTokenRulesCreateCommand({ admin: 'Admin::party' });
    const mint = buildTokenRulesOfferMintCommand({
      tokenRulesContractId: 'cid-rules',
      admin: 'Admin::party',
      receiver: 'Alice::party',
      amount: '50.0',
      offeredAt: '2026-01-01T00:00:00Z',
    });
    const transfer = buildTransferFactoryTransferCommand({
      transferFactoryContractId: 'cid-rules',
      admin: 'Admin::party',
      sender: 'Alice::party',
      receiver: 'Bob::party',
      amount: '10.0',
      inputHoldingCids: ['cid-holding'],
      requestedAt: '2026-01-01T00:00:00Z',
      executeBefore: '2026-01-08T00:00:00Z',
      extraArgs: encodeProviderLessExtraArgs({ tokenRulesContractId: 'cid-rules' }),
    });
    const accept = buildTransferInstructionAcceptCommand({
      transferInstructionContractId: 'cid-instr',
      actors: ['Bob::party'],
      extraArgs: encodeProviderLessExtraArgs({ tokenRulesContractId: 'cid-rules' }),
    });

    expect(create.createArgument['admin']).toBe('Admin::party');
    expect(mint.choiceArgument['receiver']).toEqual(providerLessAccount('Alice::party'));
    expect(transfer.choiceArgument['transfer']).toMatchObject({
      instrumentId: spliceTestTokenV2Instrument('Admin::party'),
      amount: '10.0',
    });
    expect(accept.choice).toBe('TransferInstruction_Accept');

    expect(toCreateCommand(create)).toEqual({
      CreateCommand: {
        templateId: create.templateId,
        createArguments: create.createArgument,
      },
    });
    expect(toExerciseCommand(accept).ExerciseCommand?.choice).toBe('TransferInstruction_Accept');

    expect(
      parseTransferInstructionResult({
        output: {
          tag: 'TransferInstructionResult_Pending',
          value: { transferInstructionCid: 'cid-pending' },
        },
        senderChangeCids: [],
        meta: { values: {} },
      })
    ).toEqual({ type: 'Pending', transferInstructionCid: 'cid-pending' });
  });

  it('runs upload/vet/parties/mint/transfer/assert against LocalNet when Ledger is up', async (): Promise<void> => {
    const reachable = await isLedgerReachable();

    if (!reachable) {
      if (REQUIRE_LOCALNET) {
        throw new Error(
          `LocalNet Ledger not reachable at ${LEDGER_URL}/v2/version (CANTON_CIP56_REQUIRE_LOCALNET=1)`
        );
      }
      console.warn(
        `[skip] LocalNet Ledger not reachable at ${LEDGER_URL}; leaving upload/vet/parties/mint/transfer for Docker path`
      );
      return;
    }

    expect(isSpliceTestTokenV2DarPresent(PACKAGE_ROOT)).toBe(true);

    const result = await runCip56TransferSmoke({ packageRoot: PACKAGE_ROOT });

    expect(result.adminPartyId.length).toBeGreaterThan(0);
    expect(result.alicePartyId.length).toBeGreaterThan(0);
    expect(result.bobPartyId.length).toBeGreaterThan(0);
    expect(result.tokenRulesContractId.length).toBeGreaterThan(0);
    expect(result.aliceBalance).toBe('40.0');
    expect(result.bobBalance).toBe('10.0');
    expect(result.mintOfferContractId.length).toBeGreaterThan(0);
    expect(result.transferInstructionContractId.length).toBeGreaterThan(0);
  }, 300_000);
});
