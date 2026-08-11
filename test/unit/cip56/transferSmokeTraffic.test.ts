import {
  collectErrorMessages,
  isTransientValidatorTrafficError,
} from '../../../src/testing/cip56/transferSmoke';

describe('CIP-56 transfer smoke traffic error classification', (): void => {
  it('detects HTTP 429 and traffic-balance messages in nested causes', (): void => {
    const cause = new Error(
      'ApiError: HTTP 429 [request: post http://localhost:3903/api/validator/v0/admin/users]'
    );
    const wrapped = new Error(
      'UnknownMutationOutcomeError: The outcome of POST http://localhost:3903/api/validator/v0/admin/users is unknown after 1 request attempt',
      { cause }
    );
    expect(isTransientValidatorTrafficError(wrapped)).toBe(true);
    expect(collectErrorMessages(wrapped)).toContain('HTTP 429');

    const traffic = new Error(
      'ABORTED: Traffic balance below reserved traffic amount (0 < 200000)'
    );
    expect(isTransientValidatorTrafficError(traffic)).toBe(true);
  });

  it('does not treat unrelated failures as traffic transients', (): void => {
    expect(isTransientValidatorTrafficError(new Error('HTTP 401 Unauthorized'))).toBe(false);
    expect(isTransientValidatorTrafficError(new Error('connection refused'))).toBe(false);
  });
});
