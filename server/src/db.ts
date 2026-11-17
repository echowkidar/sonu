import pg from 'pg';

// bigint (count(*), bigserial) as JS number; values used here stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric as number (money amounts are small, 2 decimals).
pg.types.setTypeParser(1700, (v) => Number(v));
// date as plain 'YYYY-MM-DD' string (no time-zone shift).
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', () => {
    /* idle client errors are reported by the next query; avoid crashing the process */
  });
  return pool;
}

/** Runs fn inside BEGIN/COMMIT; rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

export async function many<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}
