#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPostgRESTClient } from "./postgrest-client.js";
import { createUndercurrentMcpServer } from "./server.js";

const REQUIRED_ENV = ["KOMATIK_SUPABASE_URL", "KOMATIK_SUPABASE_KEY", "KOMATIK_USER_ID"] as const;

function validateEnv(): { url: string; key: string; userId: string } {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stderr.write(
      `[undercurrent-mcp] Missing required environment variables: ${missing.join(", ")}\n\n` +
        "Configure them in your MCP client settings:\n" +
        "  KOMATIK_SUPABASE_URL  — Your Supabase project URL\n" +
        "  KOMATIK_SUPABASE_KEY  — Your Supabase anon or service role key\n" +
        "  KOMATIK_USER_ID       — Your komatik.xyz user UUID\n",
    );
    process.exit(1);
  }

  return {
    url: process.env.KOMATIK_SUPABASE_URL!,
    key: process.env.KOMATIK_SUPABASE_KEY!,
    userId: process.env.KOMATIK_USER_ID!,
  };
}

async function main(): Promise<void> {
  const env = validateEnv();

  const client = createPostgRESTClient({
    url: env.url,
    apiKey: env.key,
  });

  const server = createUndercurrentMcpServer({
    client,
    userId: env.userId,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[undercurrent-mcp] Server started on stdio\n");
}

main().catch((err) => {
  process.stderr.write(
    `[undercurrent-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
