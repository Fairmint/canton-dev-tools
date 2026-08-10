/**
 * AccountConfig / ExtraArgs JSON helpers for Splice TestTokenV2 provider-less accounts.
 *
 * Provider-less accounts match `TSU.basicAccount p = Account (Some p) None ""`.
 * For those accounts, TestTokenV2 synthesizes AccountConfig in-choice and does not
 * require AccountConfig contract ids in the choice context.
 */

import { ACCOUNT_CONFIGS_CONTEXT_KEY, MINT_ACCOUNT_ID, TOKEN_RULES_CONTEXT_KEY } from './ids';

export interface Cip56PartyConfig {
  canInitiate: boolean;
  mustApprove: boolean;
}

export interface Cip56Account {
  owner: string | null;
  provider: string | null;
  id: string;
}

export interface Cip56InstrumentId {
  admin: string;
  id: string;
}

export interface Cip56AccountConfigRecord {
  admin: string;
  account: Cip56Account;
  ownerConfig: Cip56PartyConfig;
  providerConfig: Cip56PartyConfig;
}

export interface Cip56Metadata {
  values: Record<string, string>;
}

export interface Cip56ChoiceContext {
  values: Record<string, unknown>;
}

export interface Cip56ExtraArgs {
  context: Cip56ChoiceContext;
  meta: Cip56Metadata;
}

export const emptyMetadata = (): Cip56Metadata => ({ values: {} });

export const emptyChoiceContext = (): Cip56ChoiceContext => ({ values: {} });

export const emptyExtraArgs = (): Cip56ExtraArgs => ({
  context: emptyChoiceContext(),
  meta: emptyMetadata(),
});

/** Provider-less self-custodial account (`basicAccount`). */
export function providerLessAccount(owner: string): Cip56Account {
  return { owner, provider: null, id: '' };
}

/** Special mint-source account (`mintAccount`). */
export function mintAccount(): Cip56Account {
  return { owner: null, provider: null, id: MINT_ACCOUNT_ID };
}

/** Owner can initiate and must approve; provider flags are inert when provider is null. */
export function providerLessAccountConfig(admin: string, owner: string): Cip56AccountConfigRecord {
  return {
    admin,
    account: providerLessAccount(owner),
    ownerConfig: { canInitiate: true, mustApprove: true },
    providerConfig: { canInitiate: false, mustApprove: false },
  };
}

/**
 * Encode ExtraArgs for provider-less flows.
 *
 * When `tokenRulesContractId` is set, embeds `testTokenV2/tokenRules` (required by
 * TestTokenV2 EventLog lookups during transfer / mint accept). Optional AccountConfig
 * contract ids go under `testTokenV2/accountConfigs` (unused for pure provider-less).
 */
export function encodeProviderLessExtraArgs(
  options: {
    tokenRulesContractId?: string;
    accountConfigContractIds?: readonly string[];
    meta?: Record<string, string>;
  } = {}
): Cip56ExtraArgs {
  const values: Record<string, unknown> = {};

  if (options.tokenRulesContractId) {
    values[TOKEN_RULES_CONTEXT_KEY] = {
      tag: 'AV_ContractId',
      value: options.tokenRulesContractId,
    };
  }

  if (options.accountConfigContractIds && options.accountConfigContractIds.length > 0) {
    values[ACCOUNT_CONFIGS_CONTEXT_KEY] = {
      tag: 'AV_List',
      value: options.accountConfigContractIds.map((cid) => ({
        tag: 'AV_ContractId',
        value: cid,
      })),
    };
  }

  return {
    context: { values },
    meta: { values: { ...(options.meta ?? {}) } },
  };
}
