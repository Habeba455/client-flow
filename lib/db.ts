import { Pool, QueryResultRow } from 'pg';

const globalForDb = global as unknown as { pool?: Pool; poolErrorHandlerAttached?: boolean };
const RETRYABLE_ERROR_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '08007', '08P01']);
const SAFE_RETRY_PATTERNS = [
  /^SELECT\b/i,
  /^WITH\b/i,
  /^SHOW\b/i,
  /^EXPLAIN\b/i,
  /^VALUES\b/i,
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i,
  /^ALTER\s+TABLE\b[\s\S]+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i,
];

interface DatabaseError extends Error {
  code?: string;
  errno?: string | number;
}

function getConnectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL is required');
  }

  try {
    const url = new URL(value);
    url.searchParams.delete('schema');
    return url.toString();
  } catch {
    return value;
  }
}

export const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: getConnectionString(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pool = pool;
}

if (!globalForDb.poolErrorHandlerAttached) {
  pool.on('error', (error) => {
    console.error('[db] Idle client error', error);
  });
  globalForDb.poolErrorHandlerAttached = true;
}

function normalizeSql(text: string): string {
  return text.replace(/^\s+/, '').replace(/^\/\*[\s\S]*?\*\/\s*/g, '').replace(/^(?:--[^\n]*\n\s*)+/g, '');
}

function describeQuery(text: string): string {
  const normalized = normalizeSql(text);
  const match = normalized.match(/^[A-Z]+(?:\s+[A-Z]+)?/i);
  return match ? match[0].toUpperCase() : 'QUERY';
}

function isSafeToRetry(text: string): boolean {
  const normalized = normalizeSql(text);
  return SAFE_RETRY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isDatabaseConnectionError(error: unknown): error is DatabaseError {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as DatabaseError;
  const message = error.message.toLowerCase();
  return (
    (typeof candidate.code === 'string' && RETRYABLE_ERROR_CODES.has(candidate.code)) ||
    candidate.code === 'ECONNRESET' ||
    candidate.code === 'ETIMEDOUT' ||
    candidate.code === 'EPIPE' ||
    candidate.errno === 'ECONNRESET' ||
    candidate.errno === 'ETIMEDOUT' ||
    candidate.errno === 'EPIPE' ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('connection ended unexpectedly') ||
    message.includes('client has encountered a connection error') ||
    message.includes('server closed the connection unexpectedly') ||
    message.includes('connection not open') ||
    message.includes('connect etimedout') ||
    message.includes('socket hang up')
  );
}

async function executeQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  let releaseBrokenClient = false;

  try {
    const result = await client.query<T>(text, params);
    return result.rows;
  } catch (error) {
    releaseBrokenClient = isDatabaseConnectionError(error);
    throw error;
  } finally {
    client.release(releaseBrokenClient);
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  try {
    return await executeQuery<T>(text, params);
  } catch (error) {
    if (isDatabaseConnectionError(error) && isSafeToRetry(text)) {
      console.warn(`[db] Retrying transient failure for ${describeQuery(text)}`);
      return executeQuery<T>(text, params);
    }

    throw error;
  }
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export const db = {
  query,
  queryOne,
  pool,
};
