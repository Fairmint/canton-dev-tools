/** Template / interface ids for the Splice TestTokenV2 CIP-56 / CIP-112 path. */

export const TOKEN_RULES_TEMPLATE_ID =
  '#splice-test-token-v2:Splice.Testing.Tokens.TestTokenV2:TokenRules';

export const TOKEN_TRANSFER_OFFER_TEMPLATE_ID =
  '#splice-test-token-v2:Splice.Testing.Tokens.TestTokenV2.Transfer:TokenTransferOffer';

export const TRANSFER_FACTORY_INTERFACE_ID =
  '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory';

export const TRANSFER_INSTRUCTION_INTERFACE_ID =
  '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction';

export const HOLDING_INTERFACE_ID =
  '#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding';

/** Instrument id used by Splice `TokenStandardTestEnv` (`id = "X2"`). */
export const SPLICE_TEST_TOKEN_V2_INSTRUMENT_ID = 'X2';

/** Choice-context key for AccountConfig contract ids (provider accounts). */
export const ACCOUNT_CONFIGS_CONTEXT_KEY = 'testTokenV2/accountConfigs';

/** Choice-context key for the TokenRules / EventLog contract id. */
export const TOKEN_RULES_CONTEXT_KEY = 'testTokenV2/tokenRules';

/** Special mint-source account id from Splice Token Standard Utils (`cip-112/mint`). */
export const MINT_ACCOUNT_ID = 'cip-112/mint';
