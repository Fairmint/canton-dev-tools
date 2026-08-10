import {
  buildIntegrationTestClientConfig,
  buildLocalnetClientConfig,
  createSharedSecretJwt,
  generateTestId,
  findCreatedContractId,
  listCreatedEvents,
} from '../../../src/testing';

describe('testing helpers', (): void => {
  const originalEnv = { ...process.env };

  afterEach((): void => {
    process.env = { ...originalEnv };
  });

  it('builds a localnet client config with SDK OAuth2 defaults', (): void => {
    const config = buildLocalnetClientConfig();
    expect(config.network).toBe('localnet');
    expect(config.provider).toBe('app-provider');
    expect(buildIntegrationTestClientConfig()).toEqual(config);
  });

  it('honors Ledger URL overrides without requiring auth overrides', (): void => {
    process.env['FAIRMINT_TEST_LEDGER_API_URL'] = 'http://ledger.example:3975';
    delete process.env['FAIRMINT_TEST_AUTH_URL'];
    delete process.env['FAIRMINT_TEST_CLIENT_ID'];
    delete process.env['FAIRMINT_TEST_SHARED_SECRET'];

    const config = buildLocalnetClientConfig();
    expect(config.apis?.LEDGER_JSON_API?.apiUrl).toBe('http://ledger.example:3975');
    expect(config.provider).toBe('app-provider');
    expect(config.authUrl).toContain('openid-connect/token');
    expect(config.apis?.LEDGER_JSON_API?.auth).toMatchObject({
      grantType: 'password',
      clientId: 'app-provider-unsafe',
      username: 'app-provider',
    });
    expect(config.apis?.LEDGER_JSON_API?.auth).not.toHaveProperty('bearerToken');
  });

  it('creates a shared-secret JWT and stable test ids', (): void => {
    const token = createSharedSecretJwt({ subject: 'ledger-api-user' });
    expect(token.split('.')).toHaveLength(3);
    expect(generateTestId('demo')).toMatch(/^demo-\d+-[a-z0-9]+$/);
  });

  it('finds created contract ids from transaction trees', (): void => {
    const tree = {
      transactionTree: {
        eventsById: {
          '0': {
            CreatedTreeEvent: {
              value: {
                contractId: 'cid-1',
                templateId: '#Pkg:Mod:Holding',
                createdEventBlob: 'blob',
                createArgument: {},
              },
            },
          },
        },
      },
    };

    expect(listCreatedEvents(tree)).toHaveLength(1);
    expect(findCreatedContractId(tree, 'Holding')).toBe('cid-1');
  });
});
