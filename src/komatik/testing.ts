import type {
  KomatikDataClient,
  KomatikFilterBuilder,
  KomatikQueryBuilder,
  KomatikQueryResult,
  KomatikWriteClient,
  KomatikWriteFilterBuilder,
  KomatikWriteQueryBuilder,
} from "./client.js";

/**
 * Creates a mock KomatikDataClient for testing. Seed it with table data
 * and the adapters will query it exactly like they query Supabase.
 *
 * Usage:
 *   const client = createMockClient({
 *     komatik_profiles: [{ id: "user-1", email: "dev@komatik.xyz", ... }],
 *     user_product_events: [{ id: "evt-1", ... }],
 *   });
 */
export function createMockClient(
  tables: Record<string, Record<string, unknown>[]>,
): KomatikDataClient {
  return {
    from(table: string): KomatikQueryBuilder {
      const rows = tables[table] ?? [];
      return createMockQueryBuilder(rows);
    },
    rpc(functionName: string): PromiseLike<KomatikQueryResult<Record<string, unknown>[]>> {
      return Promise.resolve({
        data: null,
        error: { message: `Mock RPC not implemented: ${functionName}` },
      });
    },
  };
}

function createMockQueryBuilder(rows: Record<string, unknown>[]): KomatikQueryBuilder {
  return {
    select(_columns?: string): KomatikFilterBuilder {
      return createMockFilterBuilder([...rows]);
    },
  };
}

function createMockFilterBuilder(rows: Record<string, unknown>[]): KomatikFilterBuilder {
  let filtered = rows;
  let orderCol: string | null = null;
  let orderAsc = true;
  let limitCount: number | null = null;

  const builder: KomatikFilterBuilder = {
    eq(column: string, value: unknown): KomatikFilterBuilder {
      filtered = filtered.filter((r) => r[column] === value);
      return builder;
    },
    neq(column: string, value: unknown): KomatikFilterBuilder {
      filtered = filtered.filter((r) => r[column] !== value);
      return builder;
    },
    in(column: string, values: unknown[]): KomatikFilterBuilder {
      filtered = filtered.filter((r) => values.includes(r[column]));
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }): KomatikFilterBuilder {
      orderCol = column;
      orderAsc = options?.ascending ?? true;
      return builder;
    },
    limit(count: number): KomatikFilterBuilder {
      limitCount = count;
      return builder;
    },
    single(): PromiseLike<KomatikQueryResult<Record<string, unknown>>> {
      const result = applyOrderAndLimit();
      if (result.length === 0) {
        return Promise.resolve({
          data: null,
          error: { message: "No rows found" },
        });
      }
      return Promise.resolve({ data: result[0]!, error: null });
    },
    then<TResult1, TResult2>(
      onfulfilled?:
        | ((
            value: KomatikQueryResult<Record<string, unknown>[]>,
          ) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const result = applyOrderAndLimit();
      const resolved: KomatikQueryResult<Record<string, unknown>[]> = {
        data: result,
        error: null,
      };
      return Promise.resolve(resolved).then(onfulfilled, onrejected);
    },
  };

  function applyOrderAndLimit(): Record<string, unknown>[] {
    let result = [...filtered];
    if (orderCol) {
      const col = orderCol;
      result.sort((a, b) => {
        const aVal = a[col];
        const bVal = b[col];
        if (typeof aVal === "string" && typeof bVal === "string") {
          return orderAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        if (typeof aVal === "number" && typeof bVal === "number") {
          return orderAsc ? aVal - bVal : bVal - aVal;
        }
        return 0;
      });
    }
    if (limitCount !== null) {
      result = result.slice(0, limitCount);
    }
    return result;
  }

  return builder;
}

/**
 * Creates a mock KomatikWriteClient for testing write operations.
 * Tracks inserts, upserts, updates, and deletes for assertions.
 *
 * Usage:
 *   const { client, writes } = createMockWriteClient({
 *     enrichment_outcomes: [],
 *   });
 *   await outcomeWriter.writeEnrichmentRecord(...);
 *   expect(writes.enrichment_outcomes.inserts).toHaveLength(1);
 */
export interface MockWriteLog {
  inserts: Record<string, unknown>[];
  upserts: Record<string, unknown>[];
  updates: { data: Record<string, unknown>; filters: Record<string, unknown> }[];
  deletes: { filters: Record<string, unknown> }[];
}

export function createMockWriteClient(
  tables: Record<string, Record<string, unknown>[]>,
): { client: KomatikWriteClient; writes: Record<string, MockWriteLog> } {
  const writes: Record<string, MockWriteLog> = {};

  function getLog(table: string): MockWriteLog {
    if (!writes[table]) {
      writes[table] = { inserts: [], upserts: [], updates: [], deletes: [] };
    }
    return writes[table];
  }

  const client: KomatikWriteClient = {
    from(table: string): KomatikWriteQueryBuilder {
      const rows = tables[table] ?? [];
      return createMockWriteQueryBuilder(rows, getLog(table));
    },
    rpc(functionName: string): PromiseLike<KomatikQueryResult<Record<string, unknown>[]>> {
      return Promise.resolve({
        data: null,
        error: { message: `Mock RPC not implemented: ${functionName}` },
      });
    },
  };

  return { client, writes };
}

function createMockWriteQueryBuilder(
  rows: Record<string, unknown>[],
  log: MockWriteLog,
): KomatikWriteQueryBuilder {
  return {
    select(_columns?: string): KomatikFilterBuilder {
      return createMockFilterBuilder([...rows]);
    },
    insert(data: Record<string, unknown> | Record<string, unknown>[]): KomatikWriteFilterBuilder {
      const arr = Array.isArray(data) ? data : [data];
      log.inserts.push(...arr);
      return createMockWriteFilterBuilder({});
    },
    upsert(data: Record<string, unknown> | Record<string, unknown>[]): KomatikWriteFilterBuilder {
      const arr = Array.isArray(data) ? data : [data];
      log.upserts.push(...arr);
      return createMockWriteFilterBuilder({});
    },
    update(data: Record<string, unknown>): KomatikWriteFilterBuilder {
      const entry = { data, filters: {} as Record<string, unknown> };
      log.updates.push(entry);
      return createMockWriteFilterBuilder(entry.filters);
    },
    delete(): KomatikWriteFilterBuilder {
      const entry = { filters: {} as Record<string, unknown> };
      log.deletes.push(entry);
      return createMockWriteFilterBuilder(entry.filters);
    },
  };
}

function createMockWriteFilterBuilder(
  filters: Record<string, unknown>,
): KomatikWriteFilterBuilder {
  const builder: KomatikWriteFilterBuilder = {
    eq(column: string, value: unknown): KomatikWriteFilterBuilder {
      filters[column] = value;
      return builder;
    },
    neq(column: string, value: unknown): KomatikWriteFilterBuilder {
      filters[`neq:${column}`] = value;
      return builder;
    },
    in(column: string, values: unknown[]): KomatikWriteFilterBuilder {
      filters[`in:${column}`] = values;
      return builder;
    },
    lt(column: string, value: unknown): KomatikWriteFilterBuilder {
      filters[`lt:${column}`] = value;
      return builder;
    },
    order(_column: string, _options?: { ascending?: boolean }): KomatikWriteFilterBuilder {
      return builder;
    },
    limit(_count: number): KomatikWriteFilterBuilder {
      return builder;
    },
    single(): PromiseLike<KomatikQueryResult<Record<string, unknown>>> {
      return Promise.resolve({ data: {}, error: null });
    },
    then<TResult1, TResult2>(
      onfulfilled?:
        | ((value: KomatikQueryResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const resolved: KomatikQueryResult<Record<string, unknown>[]> = {
        data: [],
        error: null,
      };
      return Promise.resolve(resolved).then(onfulfilled, onrejected);
    },
  };
  return builder;
}
