import type {
  KomatikDataClient,
  KomatikFilterBuilder,
  KomatikQueryBuilder,
  KomatikQueryResult,
} from "../komatik/client.js";

export interface PostgRESTClientOptions {
  url: string;
  apiKey: string;
}

/**
 * Lightweight PostgREST client that satisfies KomatikDataClient using native
 * fetch. Translates the chained query builder API into Supabase PostgREST
 * URL parameters — no @supabase/supabase-js required.
 */
export function createPostgRESTClient(options: PostgRESTClientOptions): KomatikDataClient {
  const baseUrl = options.url.replace(/\/+$/, "");
  const restUrl = `${baseUrl}/rest/v1`;

  return {
    from(table: string): KomatikQueryBuilder {
      return new PostgRESTQueryBuilder(restUrl, options.apiKey, table);
    },
  };
}

class PostgRESTQueryBuilder implements KomatikQueryBuilder {
  constructor(
    private readonly restUrl: string,
    private readonly apiKey: string,
    private readonly table: string,
  ) {}

  select(columns?: string): KomatikFilterBuilder {
    return new PostgRESTFilterBuilder(this.restUrl, this.apiKey, this.table, columns ?? "*");
  }
}

class PostgRESTFilterBuilder implements KomatikFilterBuilder {
  private readonly filters: string[] = [];
  private orderClause: string | null = null;
  private limitCount: number | null = null;

  constructor(
    private readonly restUrl: string,
    private readonly apiKey: string,
    private readonly table: string,
    private readonly columns: string,
  ) {}

  eq(column: string, value: unknown): KomatikFilterBuilder {
    this.filters.push(`${encodeURIComponent(column)}=eq.${encodeURIComponent(String(value))}`);
    return this;
  }

  neq(column: string, value: unknown): KomatikFilterBuilder {
    this.filters.push(`${encodeURIComponent(column)}=neq.${encodeURIComponent(String(value))}`);
    return this;
  }

  in(column: string, values: unknown[]): KomatikFilterBuilder {
    const encoded = values.map((v) => `"${String(v)}"`).join(",");
    this.filters.push(`${encodeURIComponent(column)}=in.(${encoded})`);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): KomatikFilterBuilder {
    const direction = options?.ascending === false ? "desc" : "asc";
    this.orderClause = `${encodeURIComponent(column)}.${direction}`;
    return this;
  }

  limit(count: number): KomatikFilterBuilder {
    this.limitCount = count;
    return this;
  }

  single(): PromiseLike<KomatikQueryResult<Record<string, unknown>>> {
    return this.execute(true) as PromiseLike<KomatikQueryResult<Record<string, unknown>>>;
  }

  then<TResult1 = KomatikQueryResult<Record<string, unknown>[]>, TResult2 = never>(
    onfulfilled?:
      | ((value: KomatikQueryResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return (this.execute(false) as Promise<KomatikQueryResult<Record<string, unknown>[]>>).then(
      onfulfilled,
      onrejected,
    );
  }

  private async execute(
    single: boolean,
  ): Promise<
    KomatikQueryResult<Record<string, unknown>> | KomatikQueryResult<Record<string, unknown>[]>
  > {
    const params: string[] = [`select=${encodeURIComponent(this.columns)}`];
    params.push(...this.filters);

    if (this.orderClause) {
      params.push(`order=${this.orderClause}`);
    }
    if (this.limitCount !== null) {
      params.push(`limit=${this.limitCount}`);
    }

    const url = `${this.restUrl}/${encodeURIComponent(this.table)}?${params.join("&")}`;

    const headers: Record<string, string> = {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    if (single) {
      headers["Accept"] = "application/vnd.pgrst.object+json";
    }

    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const body = await response.text();
        let message = `PostgREST error: ${response.status} ${response.statusText}`;
        try {
          const parsed = JSON.parse(body) as { message?: string; code?: string };
          if (parsed.message) message = parsed.message;
          return { data: null, error: { message, code: parsed.code } };
        } catch {
          return { data: null, error: { message } };
        }
      }

      const data = (await response.json()) as Record<string, unknown> | Record<string, unknown>[];

      if (single) {
        if (data === null || (Array.isArray(data) && data.length === 0)) {
          return { data: null, error: { message: "No rows found", code: "PGRST116" } };
        }
        return { data: data as Record<string, unknown>, error: null };
      }

      return {
        data: (Array.isArray(data) ? data : [data]) as Record<string, unknown>[],
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown fetch error";
      return { data: null, error: { message } };
    }
  }
}

export { PostgRESTQueryBuilder as _PostgRESTQueryBuilder };
export { PostgRESTFilterBuilder as _PostgRESTFilterBuilder };
