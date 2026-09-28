/** D-056 currencies-v1: the sole approved billing currency. */
export const CURRENCY_LIST_VERSION = 'currencies-v1';
export const SUPPORTED_CURRENCIES = [{ code: 'PHP', minorUnits: 2 }] as const;

export function hasSupportedCurrencyPrecision(amount: string, currencyCode: string): boolean {
  const currency = SUPPORTED_CURRENCIES.find((item) => item.code === currencyCode);
  if (!currency) return false;
  const fractional = amount.split('.')[1];
  return (
    fractional !== undefined &&
    fractional.length === 2 &&
    [...fractional.slice(currency.minorUnits)].every((digit) => digit === '0')
  );
}
