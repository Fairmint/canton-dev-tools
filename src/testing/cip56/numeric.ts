/**
 * Decimal-safe helpers for Daml Numeric / Decimal JSON strings.
 *
 * Ledger JSON rejects scientific notation (`1e-7`). Prefer these helpers over
 * `String(number)` / IEEE-754 float compares when talking to the Ledger.
 */

/** Instrument decimals for Splice TestTokenV2 holdings (DAML Decimal precision). */
export const SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS = 10;

const DAML_NUMERIC_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function assertScale(scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 37) {
    throw new Error(`Invalid Daml Numeric scale: ${scale}`);
  }
  return scale;
}

/**
 * Parse a decimal string into signed base units for the given scale.
 * Rejects scientific notation and excess fractional precision.
 */
export function parseDamlNumericToBaseUnits(
  amount: string,
  scale: number = SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS
): bigint {
  assertScale(scale);
  const trimmed = amount.trim();
  if (!DAML_NUMERIC_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid Daml Numeric string (scientific notation and non-decimal forms rejected): ${JSON.stringify(amount)}`
    );
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fractionRaw = ''] = unsigned.split('.');
  if (fractionRaw.length > scale) {
    throw new Error(
      `Daml Numeric ${JSON.stringify(amount)} has more than ${scale} fractional digits`
    );
  }

  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const fraction = fractionRaw.padEnd(scale, '0');
  const units = BigInt(`${whole}${fraction}` || '0');
  return negative ? -units : units;
}

/** Format signed base units as a Daml Numeric JSON string (never scientific notation). */
export function formatDamlNumericFromBaseUnits(
  units: bigint,
  scale: number = SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS
): string {
  assertScale(scale);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const digits = absolute.toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fractionRaw = scale === 0 ? '' : digits.slice(-scale);
  const fraction = fractionRaw.replace(/0+$/, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/**
 * Normalize `string | number` into a Daml Numeric JSON string.
 * Numbers are converted via fixed-point base units (no `String(n)` / `1e-7`).
 */
export function formatDamlNumeric(
  amount: string | number,
  scale: number = SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS
): string {
  assertScale(scale);

  if (typeof amount === 'string') {
    const units = parseDamlNumericToBaseUnits(amount, scale);
    return formatDamlNumericFromBaseUnits(units, scale);
  }

  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`Invalid Daml Numeric amount: ${String(amount)}`);
  }

  // toFixed never emits scientific notation; parse back through the string path
  // so we reject values that still cannot fit the instrument scale cleanly.
  const fixed = amount.toFixed(scale);
  const units = parseDamlNumericToBaseUnits(fixed, scale);
  return formatDamlNumericFromBaseUnits(units, scale);
}

/** Exact decimal subtraction in instrument base units, returned as a Daml Numeric string. */
export function subtractDamlNumeric(
  left: string,
  right: string,
  scale: number = SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS
): string {
  return formatDamlNumericFromBaseUnits(
    parseDamlNumericToBaseUnits(left, scale) - parseDamlNumericToBaseUnits(right, scale),
    scale
  );
}

/** Sum decimal amount strings in instrument base units. */
export function sumDamlNumeric(
  amounts: readonly string[],
  scale: number = SPLICE_TEST_TOKEN_V2_INSTRUMENT_DECIMALS
): string {
  const total = amounts.reduce(
    (acc, amount) => acc + parseDamlNumericToBaseUnits(amount, scale),
    0n
  );
  return formatDamlNumericFromBaseUnits(total, scale);
}
