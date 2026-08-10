/**
 * LocalNet CIP-56 / CIP-112 transfer smoke orchestration (Splice TestTokenV2 only).
 *
 * Sequence: validate DAR → upload/vet → create parties → TokenRules → OfferMint →
 * Accept → TransferFactory_Transfer → Accept → assert holdings.
 */

import { readFileSync } from 'node:fs';

import {
  createParty,
  listTokenStandardV2Holdings,
  type Command,
  type LedgerJsonApiClient,
  type ValidatorApiClient,
} from '@fairmint/canton-node-sdk';

import { generateTestId } from '../testConfig';
import {
  getLocalnetParticipantAdminLedgerClient,
  getLocalnetValidatorClient,
} from '../localnetLedgerClients';
import {
  buildDisclosedContract,
  findCreatedContractId,
  findExerciseResult,
  type LedgerDisclosedContract,
} from '../transactionHelpers';
import {
  buildTokenRulesCreateCommand,
  buildTokenRulesOfferMintCommand,
  buildTransferFactoryTransferCommand,
  buildTransferInstructionAcceptCommand,
  type LedgerCreateCommand,
  type LedgerExerciseCommand,
} from './commands';
import { encodeProviderLessExtraArgs, providerLessAccount, type Cip56ExtraArgs } from './accounts';
import {
  computeSha256,
  isSpliceTestTokenV2DarPresent,
  SPLICE_TEST_TOKEN_V2_PACKAGE_ID,
  SPLICE_TEST_TOKEN_V2_SHA256,
  spliceTestTokenV2DarPath,
} from './fixture';
import {
  HOLDING_INTERFACE_ID,
  SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID,
  TOKEN_RULES_TEMPLATE_ID,
  TOKEN_TRANSFER_OFFER_TEMPLATE_ID,
} from './ids';
import {
  formatDamlNumeric,
  SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS,
  subtractDamlNumeric,
  sumDamlNumeric,
} from './numeric';

export { SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS };

const DEFAULT_MINT_AMOUNT = '50';
const DEFAULT_TRANSFER_AMOUNT = '10';

export interface Cip56TransferSmokeOptions {
  readonly packageRoot?: string;
  readonly mintAmount?: string;
  readonly transferAmount?: string;
  readonly ledger?: LedgerJsonApiClient;
  readonly validator?: ValidatorApiClient;
}

export interface Cip56TransferSmokeResult {
  readonly adminPartyId: string;
  readonly alicePartyId: string;
  readonly bobPartyId: string;
  readonly tokenRulesContractId: string;
  readonly mintAmount: string;
  readonly transferAmount: string;
  readonly aliceBalance: string;
  readonly bobBalance: string;
  readonly mintOfferContractId: string;
  readonly transferInstructionContractId: string;
}

export function toCreateCommand(command: LedgerCreateCommand): Command {
  return {
    CreateCommand: {
      templateId: command.templateId,
      createArguments: command.createArgument as Command extends {
        CreateCommand: { createArguments: infer A };
      }
        ? A
        : never,
    },
  };
}

export function toExerciseCommand(command: LedgerExerciseCommand): Command {
  return {
    ExerciseCommand: {
      templateId: command.templateId,
      contractId: command.contractId,
      choice: command.choice,
      choiceArgument: command.choiceArgument as Command extends {
        ExerciseCommand: { choiceArgument: infer A };
      }
        ? A
        : never,
    },
  };
}

export interface TransferInstructionResultParsed {
  readonly type: 'Pending' | 'Completed' | 'Failed';
  readonly transferInstructionCid?: string;
  readonly receiverHoldingCids?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parse CIP-112 V2 TransferInstructionResult JSON (`tag` / `value` encoding). */
export function parseTransferInstructionResult(
  exerciseResult: unknown
): TransferInstructionResultParsed {
  if (!isRecord(exerciseResult)) {
    throw new Error(
      `TransferInstructionResult is not an object: ${JSON.stringify(exerciseResult)}`
    );
  }
  const output = exerciseResult['output'];
  if (!isRecord(output)) {
    throw new Error(`TransferInstructionResult.output missing: ${JSON.stringify(exerciseResult)}`);
  }
  const tag = readNonEmptyString(output['tag']);
  if (!tag) {
    throw new Error(
      `TransferInstructionResult.output.tag missing: ${JSON.stringify(exerciseResult)}`
    );
  }

  if (tag === 'TransferInstructionResult_Failed') {
    return { type: 'Failed' };
  }

  const value = output['value'];
  if (tag === 'TransferInstructionResult_Pending') {
    const cid =
      readNonEmptyString(value) ??
      (isRecord(value) ? readNonEmptyString(value['transferInstructionCid']) : undefined);
    if (!cid) {
      throw new Error(`Pending result missing transferInstructionCid: ${JSON.stringify(output)}`);
    }
    return { type: 'Pending', transferInstructionCid: cid };
  }

  if (tag === 'TransferInstructionResult_Completed') {
    const variant = isRecord(value) ? value : undefined;
    const cids = variant?.['receiverHoldingCids'];
    if (!Array.isArray(cids) || !cids.every((c) => typeof c === 'string')) {
      throw new Error(`Completed result missing receiverHoldingCids: ${JSON.stringify(output)}`);
    }
    return { type: 'Completed', receiverHoldingCids: cids };
  }

  throw new Error(`Unknown TransferInstructionResult tag: ${tag}`);
}

function daysFromNowIso(days: number, fromMs: number = Date.now()): string {
  return new Date(fromMs + days * 24 * 60 * 60 * 1000).toISOString();
}

async function grantActAsRights(
  ledger: LedgerJsonApiClient,
  partyIds: readonly string[]
): Promise<void> {
  const authenticated = await ledger.getAuthenticatedUser({});
  const userId = authenticated.user.id;
  await ledger.grantUserRights({
    userId,
    rights: partyIds.map((party) => ({
      kind: { CanActAs: { value: { party } } },
    })),
  });
}

async function discloseTokenRules(
  ledger: LedgerJsonApiClient,
  params: {
    tokenRulesContractId: string;
    tokenRulesTemplateId: string;
    synchronizerId: string;
    adminPartyId: string;
  }
): Promise<LedgerDisclosedContract> {
  return buildDisclosedContract(ledger, {
    contractId: params.tokenRulesContractId,
    templateId: params.tokenRulesTemplateId,
    synchronizerId: params.synchronizerId,
    readAsParty: params.adminPartyId,
  });
}

async function listUnlockedHoldings(
  ledger: LedgerJsonApiClient,
  params: {
    partyId: string;
    adminPartyId: string;
  }
): Promise<{ contractIds: string[]; amounts: string[]; total: string }> {
  const holdings = await listTokenStandardV2Holdings({
    ledger,
    parties: [params.partyId],
    account: providerLessAccount(params.partyId),
    instrumentId: {
      admin: params.adminPartyId,
      id: SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID,
    },
    instrumentDecimals: SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS,
    holdingInterfaceId: HOLDING_INTERFACE_ID,
  });
  const unlocked = holdings.filter((holding) => holding.lock === null);
  const contractIds = unlocked.map((holding) => holding.contractId);
  const amounts = unlocked.map((holding) => holding.amount);
  return { contractIds, amounts, total: sumDamlNumeric(amounts) };
}

/**
 * Run the full Splice TestTokenV2 CIP-56 / CIP-112 LocalNet transfer smoke.
 *
 * @throws When the fixture DAR is missing/mismatched or LocalNet Ledger / Validator is unreachable.
 */
export async function runCip56TransferSmoke(
  options: Cip56TransferSmokeOptions = {}
): Promise<Cip56TransferSmokeResult> {
  const packageRoot = options.packageRoot ?? process.cwd();
  const mintAmount = formatDamlNumeric(options.mintAmount ?? DEFAULT_MINT_AMOUNT);
  const transferAmount = formatDamlNumeric(options.transferAmount ?? DEFAULT_TRANSFER_AMOUNT);
  const darPath = spliceTestTokenV2DarPath(packageRoot);

  if (!isSpliceTestTokenV2DarPresent(packageRoot)) {
    const actual = (() => {
      try {
        return computeSha256(darPath);
      } catch {
        return '(missing)';
      }
    })();
    throw new Error(
      `Splice TestTokenV2 DAR missing or hash mismatch at ${darPath}. ` +
        `Expected ${SPLICE_TEST_TOKEN_V2_SHA256}, got ${actual}. ` +
        `Run: npm run fixture:splice-test-token-v2:fetch`
    );
  }

  const ledger = options.ledger ?? (await getLocalnetParticipantAdminLedgerClient());
  const validator = options.validator ?? (await getLocalnetValidatorClient());

  const darFile = readFileSync(darPath);

  // 2–3. validate + upload/vet
  await ledger.validateDar({ darFile });
  await ledger.uploadDar({ darFile, vetAllPackages: true });

  const packages = await ledger.listPackages();
  if (!packages.packageIds.includes(SPLICE_TEST_TOKEN_V2_PACKAGE_ID)) {
    throw new Error(
      `Uploaded DAR but package id ${SPLICE_TEST_TOKEN_V2_PACKAGE_ID} is not in listPackages()`
    );
  }
  const packageStatus = await ledger.getPackageStatus({
    packageId: SPLICE_TEST_TOKEN_V2_PACKAGE_ID,
  });
  if (packageStatus.packageStatus !== 'PACKAGE_STATUS_REGISTERED') {
    throw new Error(
      `Expected PACKAGE_STATUS_REGISTERED for ${SPLICE_TEST_TOKEN_V2_PACKAGE_ID}, got ${JSON.stringify(packageStatus)}`
    );
  }

  // 4. parties (amount 0 — identity only, no amulet funding)
  const runId = generateTestId('cip56');
  const { partyId: adminPartyId } = await createParty({
    ledgerClient: ledger,
    validatorClient: validator,
    partyName: `${runId}-admin`,
    amount: '0',
  });
  const { partyId: alicePartyId } = await createParty({
    ledgerClient: ledger,
    validatorClient: validator,
    partyName: `${runId}-alice`,
    amount: '0',
  });
  const { partyId: bobPartyId } = await createParty({
    ledgerClient: ledger,
    validatorClient: validator,
    partyName: `${runId}-bob`,
    amount: '0',
  });

  await grantActAsRights(ledger, [adminPartyId, alicePartyId, bobPartyId]);
  ledger.setPartyId(adminPartyId);

  // 5. TokenRules
  const createTree = await ledger.submitAndWaitForTransactionTree({
    actAs: [adminPartyId],
    commands: [toCreateCommand(buildTokenRulesCreateCommand({ admin: adminPartyId }))],
  });
  const tokenRulesContractId = findCreatedContractId(createTree, 'TokenRules');
  const tokenRulesEvents = await ledger.getEventsByContractId({
    contractId: tokenRulesContractId,
    readAs: [adminPartyId],
  });
  const synchronizerId = tokenRulesEvents.created?.synchronizerId;
  if (!synchronizerId) {
    throw new Error(`Could not resolve synchronizerId for TokenRules ${tokenRulesContractId}`);
  }
  // Prefer the package-name template id for ACS filters (Ledger rejects raw package-id refs).
  const tokenRulesTemplateId = TOKEN_RULES_TEMPLATE_ID;

  const tokenRulesDisclosure = await discloseTokenRules(ledger, {
    tokenRulesContractId,
    tokenRulesTemplateId,
    synchronizerId,
    adminPartyId,
  });
  const extraArgs: Cip56ExtraArgs = encodeProviderLessExtraArgs({
    tokenRulesContractId,
  });

  // 6. mint — OfferMint (admin) then Accept (alice)
  // offeredAt must be <= ledger time (assertDeadlineExceeded).
  const offeredAt = new Date(Date.now() - 60_000).toISOString();
  const offerMintTree = await ledger.submitAndWaitForTransactionTree({
    actAs: [adminPartyId],
    commands: [
      toExerciseCommand(
        buildTokenRulesOfferMintCommand({
          tokenRulesContractId,
          admin: adminPartyId,
          receiver: alicePartyId,
          amount: mintAmount,
          offeredAt,
        })
      ),
    ],
  });

  const offerMintResult = findExerciseResult<{ offerCid?: string }>(
    offerMintTree,
    'TokenRules_OfferMint'
  );
  const mintOfferContractId =
    (typeof offerMintResult?.offerCid === 'string' && offerMintResult.offerCid) ||
    findCreatedContractId(offerMintTree, 'TokenTransferOffer');

  const mintAcceptTree = await ledger.submitAndWaitForTransactionTree({
    actAs: [alicePartyId],
    disclosedContracts: [tokenRulesDisclosure],
    commands: [
      toExerciseCommand(
        buildTransferInstructionAcceptCommand({
          transferInstructionContractId: mintOfferContractId,
          actors: [alicePartyId],
          extraArgs,
        })
      ),
    ],
  });
  const mintAcceptParsed = parseTransferInstructionResult(
    findExerciseResult(mintAcceptTree, 'TransferInstruction_Accept')
  );
  if (mintAcceptParsed.type !== 'Completed') {
    throw new Error(
      `Expected mint Accept to Complete, got ${mintAcceptParsed.type}: ${JSON.stringify(mintAcceptParsed)}`
    );
  }

  const aliceAfterMint = await listUnlockedHoldings(ledger, {
    partyId: alicePartyId,
    adminPartyId,
  });
  if (aliceAfterMint.total !== mintAmount) {
    throw new Error(
      `Alice balance after mint expected ${mintAmount}, got ${aliceAfterMint.total} (${aliceAfterMint.amounts.join(',')})`
    );
  }
  if (aliceAfterMint.contractIds.length === 0) {
    throw new Error('Alice has no unlocked holdings after mint Accept');
  }

  // 7. transfer — TransferFactory_Transfer (alice) then Accept (bob)
  const requestedAt = new Date(Date.now() - 1_000).toISOString();
  const executeBefore = daysFromNowIso(7);
  const transferTree = await ledger.submitAndWaitForTransactionTree({
    actAs: [alicePartyId],
    disclosedContracts: [tokenRulesDisclosure],
    commands: [
      toExerciseCommand(
        buildTransferFactoryTransferCommand({
          transferFactoryContractId: tokenRulesContractId,
          admin: adminPartyId,
          sender: alicePartyId,
          receiver: bobPartyId,
          amount: transferAmount,
          inputHoldingCids: aliceAfterMint.contractIds,
          requestedAt,
          executeBefore,
          actors: [alicePartyId],
          extraArgs,
        })
      ),
    ],
  });

  const transferExerciseResult = findExerciseResult(transferTree, 'TransferFactory_Transfer');
  const transferParsed = parseTransferInstructionResult(transferExerciseResult);
  if (transferParsed.type !== 'Pending' || !transferParsed.transferInstructionCid) {
    throw new Error(
      `Expected TransferFactory_Transfer Pending instruction, got ${JSON.stringify(transferParsed)} ` +
        `(raw=${JSON.stringify(transferExerciseResult)})`
    );
  }
  const transferInstructionContractId = transferParsed.transferInstructionCid;

  // Disclose the pending offer + TokenRules. Also readAs alice so the instruction is
  // visible on this participant even if bob's observer projection lags.
  const pendingDisclosure = await buildDisclosedContract(ledger, {
    contractId: transferInstructionContractId,
    templateId: TOKEN_TRANSFER_OFFER_TEMPLATE_ID,
    synchronizerId,
    readAsParty: alicePartyId,
  });

  const acceptTransferTree = await ledger.submitAndWaitForTransactionTree({
    actAs: [bobPartyId],
    readAs: [alicePartyId, adminPartyId],
    disclosedContracts: [tokenRulesDisclosure, pendingDisclosure],
    commands: [
      toExerciseCommand(
        buildTransferInstructionAcceptCommand({
          transferInstructionContractId,
          actors: [bobPartyId],
          extraArgs,
        })
      ),
    ],
  });
  const bobAcceptParsed = parseTransferInstructionResult(
    findExerciseResult(acceptTransferTree, 'TransferInstruction_Accept')
  );
  if (bobAcceptParsed.type !== 'Completed') {
    throw new Error(
      `Expected bob Accept to Complete, got ${bobAcceptParsed.type}: ${JSON.stringify(bobAcceptParsed)}`
    );
  }

  // 8. assert holdings
  const aliceAfter = await listUnlockedHoldings(ledger, {
    partyId: alicePartyId,
    adminPartyId,
  });
  const bobAfter = await listUnlockedHoldings(ledger, {
    partyId: bobPartyId,
    adminPartyId,
  });

  const expectedAlice = subtractDamlNumeric(mintAmount, transferAmount);
  const expectedBob = formatDamlNumeric(transferAmount);

  if (aliceAfter.total !== expectedAlice) {
    throw new Error(
      `Alice balance after transfer expected ${expectedAlice}, got ${aliceAfter.total}`
    );
  }
  if (bobAfter.total !== expectedBob) {
    throw new Error(`Bob balance after transfer expected ${expectedBob}, got ${bobAfter.total}`);
  }

  return {
    adminPartyId,
    alicePartyId,
    bobPartyId,
    tokenRulesContractId,
    mintAmount,
    transferAmount,
    aliceBalance: aliceAfter.total,
    bobBalance: bobAfter.total,
    mintOfferContractId,
    transferInstructionContractId,
  };
}
