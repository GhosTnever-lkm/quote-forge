'use strict';

const MONEY_SCALE = 2;
const QUANTITY_SCALE = 6;
const RATE_SCALE = 6;
const MAX_DECIMAL_LENGTH = 128;
// Keep enough precision in dollar-valued Numbers for formatting cents safely.
const MAX_SAFE_CENTS_AS_NUMBER = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 100));

function decimalToScaledInt(value, scale) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Expected a decimal string or number');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Value must be finite');
  const source = String(value).trim();
  if (!source || source.length > MAX_DECIMAL_LENGTH) throw new TypeError('Invalid decimal value');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(source);
  if (!match) throw new TypeError('Invalid decimal value');

  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new RangeError('Decimal exponent is out of range');
  const digits = (match[2] + fraction).replace(/^0+(?=\d)/, '');
  let integer = BigInt(digits || '0');
  const shift = scale + exponent - fraction.length;
  if (shift >= 0) integer *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = integer / divisor;
    const remainder = integer % divisor;
    integer = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return sign * integer;
}

function divideRoundHalfAway(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

function moneyToCents(value) { return decimalToScaledInt(value, MONEY_SCALE); }
function quantityToMicros(value) { return decimalToScaledInt(value, QUANTITY_SCALE); }
function rateToMicrosPercent(value) { return decimalToScaledInt(value, RATE_SCALE); }
function centsToDecimal(cents) {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function roundMoney(value) {
  const cents = moneyToCents(value);
  const decimal = centsToDecimal(cents);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) return decimal;
  const asNumber = Number(decimal);
  return Number.isFinite(asNumber) ? asNumber : decimal;
}

function formatCurrency(amount, currency = 'USD', locale = 'en-US') {
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('Currency must be a three-letter ISO code');
  const cents = moneyToCents(amount);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const parts = formatter.formatToParts(whole);
  let decimalSeen = false;
  const output = parts.map((part) => {
    if (part.type === 'fraction') return fraction;
    if (part.type === 'decimal') decimalSeen = true;
    return part.value;
  });
  if (!decimalSeen) throw new RangeError('Locale formatter did not provide a decimal separator');
  if (negative) {
    const minus = new Intl.NumberFormat(locale).formatToParts(-1).find((part) => part.type === 'minusSign')?.value || '-';
    output.unshift(minus);
  }
  return output.join('');
}

function validateLineItems(items) {
  const errors = [];
  if (!Array.isArray(items) || items.length === 0) return { valid: false, errors: ['At least one line item is required'] };
  items.forEach((item, index) => {
    const path = `lineItems[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (typeof item.description !== 'string' || !item.description.trim()) errors.push(`${path}.description is required`);
    try {
      if (quantityToMicros(item.quantity) <= 0n) errors.push(`${path}.quantity must be greater than zero`);
    } catch { errors.push(`${path}.quantity must be a valid decimal`); }
    try {
      if (moneyToCents(item.unitPrice) < 0n) errors.push(`${path}.unitPrice cannot be negative`);
    } catch { errors.push(`${path}.unitPrice must be a valid amount`); }
  });
  return { valid: errors.length === 0, errors };
}

function calculateTotals(lineItems, discount = { type: 'fixed', value: 0 }, taxRate = 0) {
  const validation = validateLineItems(lineItems);
  if (!validation.valid) throw new TypeError(validation.errors.join('; '));
  let subtotalCents = 0n;
  for (const item of lineItems) {
    const unitCents = moneyToCents(item.unitPrice);
    const quantityMicros = quantityToMicros(item.quantity);
    subtotalCents += divideRoundHalfAway(unitCents * quantityMicros, 10n ** BigInt(QUANTITY_SCALE));
  }

  const selectedDiscount = discount || { type: 'fixed', value: 0 };
  let discountCents = 0n;
  if (selectedDiscount.type === 'fixed') {
    discountCents = moneyToCents(selectedDiscount.value ?? 0);
    if (discountCents < 0n) throw new RangeError('Discount cannot be negative');
  } else if (selectedDiscount.type === 'percent') {
    const rate = rateToMicrosPercent(selectedDiscount.value ?? 0);
    if (rate < 0n || rate > 100n * 10n ** BigInt(RATE_SCALE)) throw new RangeError('Discount percent must be between 0 and 100');
    discountCents = divideRoundHalfAway(subtotalCents * rate, 100n * 10n ** BigInt(RATE_SCALE));
  } else throw new TypeError('Discount type must be fixed or percent');
  if (discountCents > subtotalCents) discountCents = subtotalCents;

  const taxableCents = subtotalCents - discountCents;
  let taxCents = 0n;
  if (taxRate !== null && taxRate !== undefined && taxRate !== '') {
    const rate = rateToMicrosPercent(taxRate);
    if (rate < 0n || rate > 100n * 10n ** BigInt(RATE_SCALE)) throw new RangeError('Tax percent must be between 0 and 100');
    taxCents = divideRoundHalfAway(taxableCents * rate, 100n * 10n ** BigInt(RATE_SCALE));
  }

  const totalCents = taxableCents + taxCents;
  const toNumber = (cents) => {
    const decimal = centsToDecimal(cents);
    if (cents > MAX_SAFE_CENTS_AS_NUMBER || cents < -MAX_SAFE_CENTS_AS_NUMBER) return decimal;
    return Number(decimal);
  };
  return {
    subtotal: toNumber(subtotalCents), discount: toNumber(discountCents), taxable: toNumber(taxableCents),
    tax: toNumber(taxCents), total: toNumber(totalCents),
    subtotalCents: subtotalCents.toString(), discountCents: discountCents.toString(),
    taxableCents: taxableCents.toString(), taxCents: taxCents.toString(), totalCents: totalCents.toString(),
  };
}

function generateDocumentNumber(prefix = 'INV', date = new Date(), existing = []) {
  const safePrefix = String(prefix || 'DOC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'DOC';
  const parsedDate = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(parsedDate.getTime())) throw new TypeError('A valid date is required');
  const ymd = `${parsedDate.getUTCFullYear()}${String(parsedDate.getUTCMonth() + 1).padStart(2, '0')}${String(parsedDate.getUTCDate()).padStart(2, '0')}`;
  const used = existing instanceof Set ? existing : new Set(existing);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = new Uint8Array(6);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    const suffix = [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
    const candidate = `${safePrefix}-${ymd}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Could not create a unique document number');
}

function createDocument(overrides = {}) {
  const now = new Date();
  const prefix = overrides.type === 'quote' ? 'QUO' : 'INV';
  const from = { name: '', email: '', address: '', ...(overrides.from || {}) };
  const to = { name: '', email: '', address: '', ...(overrides.to || {}) };
  return {
    schemaVersion: 1, id: globalThis.crypto?.randomUUID?.() || `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: overrides.type === 'quote' ? 'quote' : 'invoice',
    number: overrides.number || generateDocumentNumber(prefix, now), date: overrides.date || now.toISOString().slice(0, 10),
    dueDate: overrides.dueDate || '', currency: overrides.currency || 'USD',
    from, to, lineItems: Array.isArray(overrides.lineItems) ? overrides.lineItems.map((item) => ({ ...item })) : [],
    discount: { type: 'fixed', value: '0.00', ...(overrides.discount || {}) }, taxRate: overrides.taxRate ?? '',
    notes: overrides.notes || '',
  };
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateDocument(document) {
  const errors = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { valid: false, errors: ['Document must be an object'] };
  if (document.schemaVersion !== 1) errors.push('Unsupported schemaVersion');
  if (!['invoice', 'quote'].includes(document.type)) errors.push('type must be invoice or quote');
  if (typeof document.id !== 'string' || !document.id.trim()) errors.push('id is required');
  if (typeof document.number !== 'string' || !document.number.trim()) errors.push('number is required');
  if (!isValidDateOnly(document.date)) errors.push('date must use YYYY-MM-DD');
  if (document.dueDate !== '' && !isValidDateOnly(document.dueDate)) errors.push('dueDate must be empty or YYYY-MM-DD');
  if (typeof document.currency !== 'string' || !/^[A-Z]{3}$/.test(document.currency)) errors.push('currency must be a three-letter ISO code');
  for (const side of ['from', 'to']) {
    if (!document[side] || typeof document[side] !== 'object' || Array.isArray(document[side])) errors.push(`${side} must be an object`);
    else if (typeof document[side].name !== 'string') errors.push(`${side}.name must be text`);
  }
  const lines = validateLineItems(document.lineItems);
  if (!lines.valid) errors.push(...lines.errors);
  try {
    if (!document.discount || !['fixed', 'percent'].includes(document.discount.type)) throw new TypeError('Invalid discount');
    const discountValue = document.discount.type === 'percent' ? rateToMicrosPercent(document.discount.value) : moneyToCents(document.discount.value);
    if (discountValue < 0n || (document.discount.type === 'percent' && discountValue > 100n * 10n ** BigInt(RATE_SCALE))) throw new RangeError('Invalid discount value');
  } catch { errors.push('discount is invalid'); }
  try { if (document.taxRate !== '' && document.taxRate !== null && document.taxRate !== undefined) {
    const tax = rateToMicrosPercent(document.taxRate);
    if (tax < 0n || tax > 100n * 10n ** BigInt(RATE_SCALE)) throw new RangeError('Invalid tax');
  } } catch { errors.push('taxRate must be between 0 and 100'); }
  for (const key of ['notes']) if (document[key] !== undefined && typeof document[key] !== 'string') errors.push(`${key} must be text`);
  return { valid: errors.length === 0, errors };
}

function exportJSON(document) {
  const result = validateDocument(document);
  if (!result.valid) throw new TypeError(result.errors.join('; '));
  return JSON.stringify(document, null, 2);
}

function importJSON(source) {
  let document;
  try { document = typeof source === 'string' ? JSON.parse(source) : source; }
  catch { throw new TypeError('File is not valid JSON'); }
  const result = validateDocument(document);
  if (!result.valid) throw new TypeError(`Invalid QuoteForge document: ${result.errors.join('; ')}`);
  return JSON.parse(JSON.stringify(document));
}

const QuoteForgeCore = { roundMoney, formatCurrency, validateLineItems, calculateTotals, generateDocumentNumber, createDocument, validateDocument, exportJSON, importJSON };
if (typeof module !== 'undefined' && module.exports) module.exports = QuoteForgeCore;
if (typeof window !== 'undefined') window.QuoteForgeCore = QuoteForgeCore;
