import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPostgRESTClient } from "./postgrest-client.js";

const BASE_URL = "https://test-project.supabase.co";
const API_KEY = "test-api-key-123";

describe("createPostgRESTClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: new Headers(),
    } as unknown as Response;
  }

  it("builds correct REST URL for simple select", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("komatik_profiles").select("*");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/rest/v1/komatik_profiles?select=*`);
  });

  it("sends apikey and Authorization headers", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("komatik_profiles").select("*");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(API_KEY);
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("applies eq filter as query parameter", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("komatik_profiles").select("*").eq("id", "user-123");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("id=eq.user-123");
  });

  it("applies neq filter as query parameter", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("triage_intakes").select("*").neq("status", "cancelled");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("status=neq.cancelled");
  });

  it("applies in filter with quoted values", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("user_product_events").select("*").in("product", ["triage", "floe"]);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('product=in.("triage","floe")');
  });

  it("applies order clause", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("user_product_events").select("*").order("created_at", { ascending: false });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("order=created_at.desc");
  });

  it("applies ascending order by default", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("user_product_events").select("*").order("created_at");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("order=created_at.asc");
  });

  it("applies limit clause", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("user_product_events").select("*").limit(20);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("limit=20");
  });

  it("chains multiple filters, order, and limit", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client
      .from("user_product_events")
      .select("id,product,event_type")
      .eq("user_id", "user-1")
      .neq("event_type", "deleted")
      .order("created_at", { ascending: false })
      .limit(10);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("select=id%2Cproduct%2Cevent_type");
    expect(url).toContain("user_id=eq.user-1");
    expect(url).toContain("event_type=neq.deleted");
    expect(url).toContain("order=created_at.desc");
    expect(url).toContain("limit=10");
  });

  it("returns data array on successful multi-row response", async () => {
    const rows = [
      { id: "1", email: "test@komatik.xyz" },
      { id: "2", email: "dev@komatik.xyz" },
    ];
    fetchSpy.mockResolvedValue(mockResponse(rows));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    const result = await client.from("komatik_profiles").select("*");

    expect(result.data).toEqual(rows);
    expect(result.error).toBeNull();
  });

  it("sends Accept header for single() and returns single object", async () => {
    const row = { id: "user-1", email: "test@komatik.xyz" };
    fetchSpy.mockResolvedValue(mockResponse(row));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    const result = await client.from("komatik_profiles").select("*").eq("id", "user-1").single();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.pgrst.object+json");
    expect(result.data).toEqual(row);
    expect(result.error).toBeNull();
  });

  it("returns error on HTTP failure", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ message: "relation does not exist", code: "42P01" }, 400),
    );

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    const result = await client.from("nonexistent").select("*");

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toContain("relation does not exist");
    expect(result.error!.code).toBe("42P01");
  });

  it("returns error on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    const result = await client.from("komatik_profiles").select("*");

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toBe("Network error");
  });

  it("returns error for single() when no rows found", async () => {
    fetchSpy.mockResolvedValue(mockResponse(null));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    const result = await client.from("komatik_profiles").select("*").eq("id", "missing").single();

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("strips trailing slashes from the base URL", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: `${BASE_URL}///`, apiKey: API_KEY });
    await client.from("komatik_profiles").select("*");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${BASE_URL}/rest/v1/`)).toBe(true);
  });

  it("selects specific columns", async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));

    const client = createPostgRESTClient({ url: BASE_URL, apiKey: API_KEY });
    await client.from("komatik_profiles").select("id,email,display_name");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("select=id%2Cemail%2Cdisplay_name");
  });
});
