// ─── Komatik Data Client ─────────────────────────────────────────────────────
// A minimal query interface that matches Supabase's PostgREST query builder.
// Any SupabaseClient satisfies this contract without casting — but we own the
// interface, not Supabase. If the backend changes, only this contract moves.
//
// The consumer passes their already-constructed client:
//   new KomatikIdentityAdapter({ client: supabase, userId: user.id })

export interface KomatikDataClient {
  from(table: string): KomatikQueryBuilder;
}

export interface KomatikQueryBuilder {
  select(columns?: string): KomatikFilterBuilder;
}

export interface KomatikFilterBuilder {
  eq(column: string, value: unknown): KomatikFilterBuilder;
  neq(column: string, value: unknown): KomatikFilterBuilder;
  in(column: string, values: unknown[]): KomatikFilterBuilder;
  order(column: string, options?: { ascending?: boolean }): KomatikFilterBuilder;
  limit(count: number): KomatikFilterBuilder;
  single(): PromiseLike<KomatikQueryResult<Record<string, unknown>>>;
  then<TResult1 = KomatikQueryResult<Record<string, unknown>[]>, TResult2 = never>(
    onfulfilled?: ((value: KomatikQueryResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface KomatikQueryResult<T> {
  data: T | null;
  error: KomatikQueryError | null;
}

export interface KomatikQueryError {
  message: string;
  code?: string;
}

export interface KomatikAdapterOptions {
  client: KomatikDataClient;
  userId: string;
}

// ─── Write-capable extension ────────────────────────────────────────────────
// Used by KomatikSessionWriter. The standard read adapters don't need this.
// Any Supabase client satisfies both KomatikDataClient and KomatikWriteClient.

export interface KomatikWriteClient extends KomatikDataClient {
  from(table: string): KomatikWriteQueryBuilder;
}

export interface KomatikWriteQueryBuilder extends KomatikQueryBuilder {
  insert(data: Record<string, unknown> | Record<string, unknown>[]): KomatikWriteFilterBuilder;
  upsert(data: Record<string, unknown> | Record<string, unknown>[]): KomatikWriteFilterBuilder;
  delete(): KomatikWriteFilterBuilder;
  update(data: Record<string, unknown>): KomatikWriteFilterBuilder;
}

export interface KomatikWriteFilterBuilder extends KomatikFilterBuilder {
  eq(column: string, value: unknown): KomatikWriteFilterBuilder;
  neq(column: string, value: unknown): KomatikWriteFilterBuilder;
  in(column: string, values: unknown[]): KomatikWriteFilterBuilder;
  lt(column: string, value: unknown): KomatikWriteFilterBuilder;
}
