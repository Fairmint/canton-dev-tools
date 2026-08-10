/**
 * Shared LocalNet client configuration and async helpers for Canton integration tests.
 */

import { createHmac } from 'node:crypto';
import type { AuthConfig, ClientConfig } from '@fairmint/canton-node-sdk';

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export interface SharedSecretJwtOptions {
  subject?: string;
  secret?: string;
  audience?: string;
}

/** Create an HS256 JWT for cn-quickstart shared-secret LocalNet authentication. */
export function createSharedSecretJwt(options: SharedSecretJwtOptions = {}): string {
  const subject = options.subject ?? getEnv('FAIRMINT_TEST_USER_ID') ?? 'ledger-api-user';
  const secret = options.secret ?? getEnv('FAIRMINT_TEST_SHARED_SECRET') ?? 'unsafe';
  const audience = options.audience ?? 'https://canton.network.global';

  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: subject, aud: audience });
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsignedToken).digest('base64url');
  return `${unsignedToken}.${signature}`;
}

/** Stable id generator for test data (avoid collisions across runs). */
export function generateTestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a {@link ClientConfig} for LocalNet integration tests.
 *
 * Defaults match cn-quickstart's app-provider participant with OAuth2 when no auth overrides are set.
 * Set `FAIRMINT_TEST_AUTH_URL` / shared-secret env vars to switch modes.
 */
export function buildLocalnetClientConfig(): ClientConfig {
  const authUrl = getEnv('FAIRMINT_TEST_AUTH_URL');
  const network = (getEnv('FAIRMINT_TEST_NETWORK') ?? 'localnet') as ClientConfig['network'];
  const ledgerApiUrl = getEnv('FAIRMINT_TEST_LEDGER_API_URL');
  const validatorApiUrl = getEnv('FAIRMINT_TEST_VALIDATOR_API_URL');
  const scanApiUrl = getEnv('FAIRMINT_TEST_SCAN_API_URL');
  const hasAuthOverride =
    Boolean(authUrl) ||
    Boolean(getEnv('FAIRMINT_TEST_CLIENT_ID')) ||
    Boolean(getEnv('FAIRMINT_TEST_SHARED_SECRET'));
  const hasEndpointOverride =
    Boolean(ledgerApiUrl) || Boolean(validatorApiUrl) || Boolean(scanApiUrl);

  if (!hasAuthOverride && !hasEndpointOverride) {
    // SDK built-in LocalNet OAuth2 defaults (cn-quickstart option 2).
    return {
      network,
      provider: 'app-provider',
    };
  }

  // URL-only overrides keep package OAuth2 defaults (Keycloak password grant).
  const resolvedAuthUrl =
    authUrl ??
    (!hasAuthOverride
      ? 'http://localhost:8082/realms/AppProvider/protocol/openid-connect/token'
      : undefined);

  return {
    network,
    provider: 'app-provider',
    ...(resolvedAuthUrl ? { authUrl: resolvedAuthUrl } : {}),
    apis: {
      LEDGER_JSON_API: {
        apiUrl: ledgerApiUrl ?? 'http://localhost:3975',
        auth: buildAuthConfig('LEDGER_JSON_API', { preferOAuth: !hasAuthOverride }),
      },
      VALIDATOR_API: {
        apiUrl: validatorApiUrl ?? 'http://localhost:3903',
        auth: buildAuthConfig('VALIDATOR_API', { preferOAuth: !hasAuthOverride }),
      },
      SCAN_API: {
        apiUrl: scanApiUrl ?? 'http://localhost:4000',
        auth: buildAuthConfig('SCAN_API', { preferOAuth: !hasAuthOverride }),
      },
    },
  };
}

/** @deprecated Prefer {@link buildLocalnetClientConfig}. */
export const buildIntegrationTestClientConfig = buildLocalnetClientConfig;

function buildAuthConfig(
  apiType: string,
  options: { preferOAuth?: boolean } = {}
): AuthConfig {
  const apiPrefix = `FAIRMINT_TEST_${apiType}`;
  const authUrl = getEnv('FAIRMINT_TEST_AUTH_URL');
  const clientId =
    getEnv(`${apiPrefix}_CLIENT_ID`) ?? getEnv('FAIRMINT_TEST_CLIENT_ID') ?? 'fairmint-sdk';
  const clientSecret =
    getEnv(`${apiPrefix}_CLIENT_SECRET`) ?? getEnv('FAIRMINT_TEST_CLIENT_SECRET');

  if (authUrl) {
    return {
      grantType: 'client_credentials',
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  if (options.preferOAuth) {
    // cn-quickstart LocalNet OAuth2 (app-provider-unsafe password grant).
    return {
      grantType: 'password',
      clientId: 'app-provider-unsafe',
      username: 'app-provider',
      password: 'abc123',
      scope: 'openid',
    };
  }

  return {
    grantType: 'client_credentials',
    clientId,
    bearerToken: createSharedSecretJwt(),
  };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function until it succeeds or times out.
 *
 * @throws The last error if all retries fail.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    description?: string;
  } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const description = options.description ?? 'operation';
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  }

  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`
  );
}
