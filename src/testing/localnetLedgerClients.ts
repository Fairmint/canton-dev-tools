/** Role-checked Ledger JSON API clients for either cn-quickstart LocalNet authentication mode. */

import { CantonRuntime, LedgerJsonApiClient, ValidatorApiClient } from '@fairmint/canton-node-sdk';
import { createSharedSecretJwt } from './testConfig';

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const LEDGER_API_URL = getEnv('FAIRMINT_TEST_LEDGER_API_URL') ?? 'http://localhost:3975';
const VALIDATOR_API_URL = getEnv('FAIRMINT_TEST_VALIDATOR_API_URL') ?? 'http://localhost:3903';
const OAUTH_TOKEN_URL =
  getEnv('FAIRMINT_TEST_AUTH_URL') ??
  'http://localhost:8082/realms/AppProvider/protocol/openid-connect/token';

let participantAdminClientPromise: Promise<LedgerJsonApiClient> | undefined;
let nonAdminClientPromise: Promise<LedgerJsonApiClient> | undefined;
let validatorClientPromise: Promise<ValidatorApiClient> | undefined;

function memoizeClient<T>(
  read: () => Promise<T> | undefined,
  write: (value: Promise<T> | undefined) => void,
  create: () => Promise<T>
): Promise<T> {
  const existing = read();
  if (existing) {
    return existing;
  }
  const created = create().catch((error: unknown) => {
    write(undefined);
    throw error;
  });
  write(created);
  return created;
}

/** Resolve a participant-admin client without assuming LocalNet auth mode. */
export async function getLocalnetParticipantAdminLedgerClient(): Promise<LedgerJsonApiClient> {
  return memoizeClient(
    () => participantAdminClientPromise,
    (value) => {
      participantAdminClientPromise = value;
    },
    () =>
      resolveRoleCheckedClient(
        [createSharedSecretClient('ledger-api-user'), createOAuthAdminClient()],
        true
      )
  );
}

/** Resolve an authenticated client verified not to hold the ParticipantAdmin right. */
export async function getLocalnetNonAdminLedgerClient(): Promise<LedgerJsonApiClient> {
  return memoizeClient(
    () => nonAdminClientPromise,
    (value) => {
      nonAdminClientPromise = value;
    },
    () =>
      resolveRoleCheckedClient(
        [createSharedSecretClient('app-provider'), createOAuthNonAdminClient()],
        false
      )
  );
}

async function resolveRoleCheckedClient(
  candidates: readonly LedgerJsonApiClient[],
  requireParticipantAdmin: boolean
): Promise<LedgerJsonApiClient> {
  let lastError: unknown;

  for (const candidate of candidates) {
    let authenticated;
    try {
      authenticated = await candidate.getAuthenticatedUser({});
    } catch (error) {
      lastError = error;
      continue;
    }

    const rights = await candidate.listUserRights({ userId: authenticated.user.id });
    const hasParticipantAdmin =
      rights.rights?.some(
        (right) => right.kind !== undefined && 'ParticipantAdmin' in right.kind
      ) ?? false;
    if (hasParticipantAdmin !== requireParticipantAdmin) {
      lastError = new Error(
        `LocalNet fixture ${authenticated.user.id} ${
          requireParticipantAdmin ? 'does not have' : 'unexpectedly has'
        } ParticipantAdmin`
      );
      continue;
    }
    return candidate;
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Could not authenticate a role-checked LocalNet Ledger client');
}

/**
 * Resolve a Validator API client for LocalNet party onboarding (`createParty`).
 *
 * Prefers OAuth2 (package LocalNet default). Shared-secret is tried second for
 * consumer CI that runs LocalNet without Keycloak; note that some validator
 * admin endpoints only accept OAuth tokens even when getValidatorUserInfo works
 * with a shared-secret JWT.
 */
export async function getLocalnetValidatorClient(): Promise<ValidatorApiClient> {
  return memoizeClient(
    () => validatorClientPromise,
    (value) => {
      validatorClientPromise = value;
    },
    () =>
      resolveValidatorClient([
        createOAuthValidatorClient(),
        createSharedSecretValidatorClient('ledger-api-user'),
      ])
  );
}

async function resolveValidatorClient(
  candidates: readonly ValidatorApiClient[]
): Promise<ValidatorApiClient> {
  let lastAuthenticationError: unknown;

  for (const candidate of candidates) {
    try {
      await candidate.getValidatorUserInfo();
      return candidate;
    } catch (error) {
      lastAuthenticationError = error;
    }
  }

  if (lastAuthenticationError instanceof Error) {
    throw lastAuthenticationError;
  }
  throw new Error('Could not authenticate a LocalNet Validator API client');
}

function createOAuthAdminClient(): LedgerJsonApiClient {
  // SDK LocalNet OAuth defaults for ParticipantAdmin (cn-quickstart app-provider).
  return new LedgerJsonApiClient(
    new CantonRuntime({ network: 'localnet', provider: 'app-provider' })
  );
}

function createOAuthNonAdminClient(): LedgerJsonApiClient {
  return new LedgerJsonApiClient(
    new CantonRuntime({
      network: 'localnet',
      provider: 'app-provider',
      authUrl: OAUTH_TOKEN_URL,
      apis: {
        LEDGER_JSON_API: {
          apiUrl: LEDGER_API_URL,
          auth: {
            grantType: 'password',
            clientId: 'app-provider-unsafe',
            username: 'app-provider',
            password: 'abc123',
            scope: 'openid',
          },
        },
      },
    })
  );
}

function createOAuthValidatorClient(): ValidatorApiClient {
  return new ValidatorApiClient(
    new CantonRuntime({ network: 'localnet', provider: 'app-provider' })
  );
}

function createSharedSecretClient(subject: string): LedgerJsonApiClient {
  return new LedgerJsonApiClient(
    new CantonRuntime({
      network: 'localnet',
      provider: 'app-provider',
      authUrl: '',
      apis: {
        LEDGER_JSON_API: {
          apiUrl: LEDGER_API_URL,
          auth: {
            grantType: 'client_credentials',
            clientId: `shared-secret-${subject}`,
            bearerToken: createSharedSecretJwt({ subject }),
          },
        },
      },
    })
  );
}

function createSharedSecretValidatorClient(subject: string): ValidatorApiClient {
  const bearerToken = createSharedSecretJwt({ subject });
  return new ValidatorApiClient(
    new CantonRuntime({
      network: 'localnet',
      provider: 'app-provider',
      authUrl: '',
      apis: {
        LEDGER_JSON_API: {
          apiUrl: LEDGER_API_URL,
          auth: {
            grantType: 'client_credentials',
            clientId: `shared-secret-${subject}`,
            bearerToken,
          },
        },
        VALIDATOR_API: {
          apiUrl: VALIDATOR_API_URL,
          auth: {
            grantType: 'client_credentials',
            clientId: `shared-secret-${subject}`,
            bearerToken,
          },
        },
      },
    })
  );
}
