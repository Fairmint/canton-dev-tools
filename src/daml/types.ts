/** Shared types for DAML package tooling. */

/** Extracts an error message from an unknown error value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/** Valid network keys for deployment scripts. */
export type ContractNetwork = 'mainnet' | 'devnet';

/** Type guard for ContractNetwork. */
export function isContractNetwork(value: string): value is ContractNetwork {
  return value === 'mainnet' || value === 'devnet';
}
