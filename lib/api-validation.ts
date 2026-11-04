import { NextResponse } from 'next/server';

export class ApiInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ApiInputError';
    this.status = status;
  }
}

/** Maps thrown errors to consistent JSON responses. Never leaks raw database messages. */
export function errorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof ApiInputError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === '22P02' || code === '22007' || code === '22008' || code === '22001') {
    return NextResponse.json({ error: 'One of the submitted values has an invalid format.' }, { status: 400 });
  }
  if (code === '23503') {
    return NextResponse.json({ error: 'A referenced record no longer exists.' }, { status: 400 });
  }
  if (code === '23505') {
    return NextResponse.json({ error: 'A record with these details already exists.' }, { status: 409 });
  }
  if (code === '23514') {
    return NextResponse.json({ error: 'A submitted value failed a database rule.' }, { status: 400 });
  }
  console.error(`[${context}]`, error);
  return NextResponse.json({ error: 'Unexpected server error. Please try again.' }, { status: 500 });
}

/** undefined = field not sent; null = explicitly cleared; string = trimmed value. */
export function readOptionalText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiInputError(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ApiInputError(`${field} must be ${max} characters or fewer.`);
  return trimmed || null;
}

export function readRequiredText(value: unknown, field: string, max: number): string {
  const text = readOptionalText(value, field, max);
  if (!text) throw new ApiInputError(`${field} is required.`);
  return text;
}

export function readEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ApiInputError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function readDateOnly(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiInputError(`${field} must be a date in YYYY-MM-DD format.`);
  }
  return value;
}

export function readIsoDateTime(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new ApiInputError(`${field} must be a valid date and time.`);
  }
  return parsed.toISOString();
}

/** Opaque record id (project/client/task). */
export function readId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
    throw new ApiInputError(`${field} reference is invalid.`);
  }
  return value.trim();
}

export function readJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiInputError('Request body must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}
