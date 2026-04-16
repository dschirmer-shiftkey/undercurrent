import type { Pipeline } from "../engine/pipeline.js";
import type { ConversationTurn, EnrichedPrompt } from "../types.js";

/**
 * Generic HTTP middleware that enriches incoming messages before they
 * reach your LLM handler. Works with any framework that uses
 * (request, response, next) or the Web Fetch API Request/Response.
 *
 * The middleware reads a JSON body with { message, conversation? },
 * runs it through the pipeline, and attaches the EnrichedPrompt to
 * the request for downstream handlers.
 */

export interface MiddlewareRequest {
  body?: {
    message?: string;
    conversation?: ConversationTurn[];
  };
  undercurrent?: EnrichedPrompt;
}

export interface MiddlewareOptions {
  extractMessage?: (req: unknown) => { message: string; conversation?: ConversationTurn[] } | null;
  attachResult?: (req: unknown, result: EnrichedPrompt) => void;
  onError?: (error: unknown) => void;
}

/**
 * Creates an Express/Connect-style middleware.
 *
 * ```ts
 * app.use(createMiddleware(pipeline));
 *
 * app.post('/chat', (req, res) => {
 *   const enriched = req.undercurrent; // EnrichedPrompt
 *   // send enriched.enrichedMessage to your LLM
 * });
 * ```
 */
export function createMiddleware(
  pipeline: Pipeline,
  options?: MiddlewareOptions,
) {
  const extractMessage =
    options?.extractMessage ??
    ((req: unknown) => {
      const r = req as MiddlewareRequest;
      if (r.body?.message) {
        return {
          message: r.body.message,
          conversation: r.body.conversation,
        };
      }
      return null;
    });

  const attachResult =
    options?.attachResult ??
    ((req: unknown, result: EnrichedPrompt) => {
      (req as MiddlewareRequest).undercurrent = result;
    });

  return async (
    req: unknown,
    _res: unknown,
    next: (err?: unknown) => void,
  ) => {
    try {
      const input = extractMessage(req);
      if (!input) {
        next();
        return;
      }

      const enriched = await pipeline.enrich({
        message: input.message,
        conversation: input.conversation,
      });

      attachResult(req, enriched);
      next();
    } catch (error) {
      options?.onError?.(error);
      next(error);
    }
  };
}

/**
 * Creates a Web Fetch API handler wrapper for use with Hono, Next.js
 * Route Handlers, Cloudflare Workers, Deno, etc.
 *
 * ```ts
 * const enrich = createFetchHandler(pipeline);
 *
 * export async function POST(request: Request) {
 *   const { enriched, body } = await enrich(request);
 *   // enriched is the EnrichedPrompt
 *   // body is the original parsed request body
 * }
 * ```
 */
export function createFetchHandler(pipeline: Pipeline) {
  return async (request: Request) => {
    const body = (await request.json()) as {
      message?: string;
      conversation?: ConversationTurn[];
    };

    if (!body.message) {
      return { enriched: null, body };
    }

    const enriched = await pipeline.enrich({
      message: body.message,
      conversation: body.conversation,
    });

    return { enriched, body };
  };
}
