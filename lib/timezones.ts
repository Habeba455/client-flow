const FALLBACK_ALIASES: Record<string, string> = {
  'sri lanka': 'Asia/Colombo',
  colombo: 'Asia/Colombo',
  lanka: 'Asia/Colombo',
  dubai: 'Asia/Dubai',
  uae: 'Asia/Dubai',
  'united arab emirates': 'Asia/Dubai',
  london: 'Europe/London',
  uk: 'Europe/London',
  'united kingdom': 'Europe/London',
  england: 'Europe/London',
  newyork: 'America/New_York',
  'new york': 'America/New_York',
  usa: 'America/New_York',
  'united states': 'America/New_York',
  singapore: 'Asia/Singapore',
  india: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
};

function getSupportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

export function isValidIanaTimezone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezoneInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isValidIanaTimezone(trimmed)) return trimmed;

  const normalized = trimmed.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const alias = FALLBACK_ALIASES[normalized] || FALLBACK_ALIASES[normalized.replace(/\s+/g, '')];
  if (alias) return alias;

  const supported = getSupportedTimeZones();
  const normalizedNeedle = normalized.replace(/\s+/g, '');

  for (const zone of supported) {
    const parts = zone.toLowerCase().split('/');
    const city = parts[parts.length - 1]?.replace(/_/g, ' ') || '';
    const countryish = parts[0]?.replace(/_/g, ' ') || '';
    const compact = zone.toLowerCase().replace(/[\/_]/g, '');
    if (
      city === normalized ||
      city.replace(/\s+/g, '') === normalizedNeedle ||
      zone.toLowerCase() === normalized ||
      compact.includes(normalizedNeedle) ||
      countryish === normalized
    ) {
      return zone;
    }
  }

  return null;
}
