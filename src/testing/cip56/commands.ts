/**
 * Unit-testable JSON command builders for the Splice TestTokenV2 CIP-56 / CIP-112 path.
 *
 * These produce Ledger JSON API create / exercise payloads. Orchestration (upload, vet,
 * party allocation, submit) stays in scripts / integration tests.
 */

import {
  emptyExtraArgs,
  mintAccount,
  providerLessAccount,
  providerLessAccountConfig,
  type Cip56Account,
  type Cip56ExtraArgs,
  type Cip56InstrumentId,
  type Cip56Metadata,
} from './accounts';
import {
  SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID,
  TOKEN_RULES_TEMPLATE_ID,
  TRANSFER_FACTORY_INTERFACE_ID,
  TRANSFER_INSTRUCTION_INTERFACE_ID,
} from './ids';

export interface LedgerCreateCommand {
  templateId: string;
  createArgument: Record<string, unknown>;
}

export interface LedgerExerciseCommand {
  templateId: string;
  contractId: string;
  choice: string;
  choiceArgument: Record<string, unknown>;
}

export interface BuildTokenRulesCreateParams {
  admin: string;
}

/** Create TokenRules (TransferFactory + EventLog + AllocationFactory) for `admin`. */
export function buildTokenRulesCreateCommand(
  params: BuildTokenRulesCreateParams
): LedgerCreateCommand {
  return {
    templateId: TOKEN_RULES_TEMPLATE_ID,
    createArgument: {
      admin: params.admin,
    },
  };
}

export interface BuildOfferMintParams {
  tokenRulesContractId: string;
  admin: string;
  receiver: string;
  amount: string | number;
  instrumentId?: string;
  offeredAt: string;
  receiverConfig?: ReturnType<typeof providerLessAccountConfig>;
}

/** Exercise TokenRules_OfferMint (admin controller). */
export function buildTokenRulesOfferMintCommand(
  params: BuildOfferMintParams
): LedgerExerciseCommand {
  const instrumentId: Cip56InstrumentId = {
    admin: params.admin,
    id: params.instrumentId ?? SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID,
  };
  const receiverAccount = providerLessAccount(params.receiver);

  return {
    templateId: TOKEN_RULES_TEMPLATE_ID,
    contractId: params.tokenRulesContractId,
    choice: 'TokenRules_OfferMint',
    choiceArgument: {
      receiver: receiverAccount,
      amount: String(params.amount),
      instrumentId,
      offeredAt: params.offeredAt,
      receiverConfig:
        params.receiverConfig ?? providerLessAccountConfig(params.admin, params.receiver),
    },
  };
}

export interface Cip56Transfer {
  sender: Cip56Account;
  receiver: Cip56Account;
  amount: string;
  instrumentId: Cip56InstrumentId;
  inputHoldingCids: readonly string[];
  requestedAt: string;
  executeBefore: string;
  meta: Cip56Metadata;
}

export interface BuildTransferFactoryTransferParams {
  /** TokenRules contract id implementing TransferFactory. */
  transferFactoryContractId: string;
  admin: string;
  sender: string;
  receiver: string;
  amount: string | number;
  inputHoldingCids: readonly string[];
  requestedAt: string;
  executeBefore: string;
  actors?: readonly string[];
  instrumentId?: string;
  meta?: Record<string, string>;
  extraArgs?: Cip56ExtraArgs;
  /** Exercise via the V2 TransferFactory interface id (default) or the TokenRules template id. */
  useInterfaceId?: boolean;
}

/** Build CIP-112 V2 TransferFactory_Transfer choice args / exercise command. */
export function buildTransferFactoryTransferCommand(
  params: BuildTransferFactoryTransferParams
): LedgerExerciseCommand {
  const transfer: Cip56Transfer = {
    sender: providerLessAccount(params.sender),
    receiver: providerLessAccount(params.receiver),
    amount: String(params.amount),
    instrumentId: {
      admin: params.admin,
      id: params.instrumentId ?? SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID,
    },
    inputHoldingCids: [...params.inputHoldingCids],
    requestedAt: params.requestedAt,
    executeBefore: params.executeBefore,
    meta: { values: { ...(params.meta ?? {}) } },
  };

  return {
    templateId:
      params.useInterfaceId === false ? TOKEN_RULES_TEMPLATE_ID : TRANSFER_FACTORY_INTERFACE_ID,
    contractId: params.transferFactoryContractId,
    choice: 'TransferFactory_Transfer',
    choiceArgument: {
      transfer,
      actors: [...(params.actors ?? [params.sender])],
      extraArgs: params.extraArgs ?? emptyExtraArgs(),
    },
  };
}

export interface BuildTransferInstructionAcceptParams {
  transferInstructionContractId: string;
  actors: readonly string[];
  extraArgs?: Cip56ExtraArgs;
}

/** Build CIP-112 V2 TransferInstruction_Accept exercise command. */
export function buildTransferInstructionAcceptCommand(
  params: BuildTransferInstructionAcceptParams
): LedgerExerciseCommand {
  return {
    templateId: TRANSFER_INSTRUCTION_INTERFACE_ID,
    contractId: params.transferInstructionContractId,
    choice: 'TransferInstruction_Accept',
    choiceArgument: {
      actors: [...params.actors],
      extraArgs: params.extraArgs ?? emptyExtraArgs(),
    },
  };
}

/** Instrument `{ admin, id: 'X2' }` matching Splice TokenStandardTestEnv. */
export function spliceTestTokenV2Instrument(admin: string): Cip56InstrumentId {
  return { admin, id: SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID };
}

export { mintAccount, providerLessAccount, providerLessAccountConfig };
