import { createInterface } from "node:readline";
import { Undercurrent } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { GitAdapter } from "../adapters/git.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { DefaultStrategy } from "../strategies/default.js";
import { formatResult } from "./formatter.js";
import { parseTranscript } from "./transcript-parser.js";
import type { ConversationTurn, TargetPlatform } from "../types.js";

const PLATFORMS: TargetPlatform[] = ["cursor", "claude", "chatgpt", "api", "mcp", "generic"];

let platform: TargetPlatform = "generic";
let verbose = false;
let conversation: ConversationTurn[] = [];

function createPipeline(debug: boolean): Undercurrent {
  return new Undercurrent({
    adapters: [
      new ConversationAdapter(),
      new GitAdapter({ cwd: process.cwd() }),
      new FilesystemAdapter({ root: "./src" }),
    ],
    strategy: new DefaultStrategy(),
    targetPlatform: platform,
    debug,
  });
}

let uc = createPipeline(false);

function printHelp(): void {
  console.log(`
\x1b[1mUndercurrent Playground\x1b[0m

Commands:
  /platform <name>   Switch output platform (${PLATFORMS.join(", ")})
  /debug             Toggle verbose/debug mode
  /reset             Clear conversation history
  /replay <path>     Replay a transcript file through the pipeline
  /history           Show current conversation history
  /help              Show this help
  /quit              Exit

Type any message to run it through the pipeline.
`);
}

function printBanner(): void {
  console.log(`
\x1b[1m\x1b[36m╔══════════════════════════════════════╗
║   Undercurrent Playground            ║
║   Type messages to see enrichment    ║
║   /help for commands                 ║
╚══════════════════════════════════════╝\x1b[0m
  Platform: ${platform} | Debug: ${verbose} | History: ${conversation.length} turns
`);
}

async function handleReplay(filePath: string): Promise<void> {
  console.log(`\nReplaying transcript: ${filePath}\n`);

  let entries;
  try {
    entries = await parseTranscript(filePath);
  } catch (err) {
    console.error(`Failed to parse transcript: ${(err as Error).message}`);
    return;
  }

  console.log(`Found ${entries.length} user messages\n`);

  for (const entry of entries) {
    const preview = entry.rawMessage.slice(0, 80).replace(/\n/g, " ");
    console.log(`\x1b[1m\x1b[33m── Message ${entry.index + 1}: \x1b[0m${preview}${entry.rawMessage.length > 80 ? "..." : ""}`);

    const result = await uc.enrich({
      message: entry.rawMessage,
      conversation: entry.conversationSoFar,
      targetPlatform: platform,
    });

    console.log(formatResult(result, verbose));
  }
}

async function handleMessage(message: string): Promise<void> {
  const result = await uc.enrich({
    message,
    conversation,
    targetPlatform: platform,
  });

  console.log(formatResult(result, verbose));

  conversation.push({ role: "user", content: message });
  conversation.push({
    role: "assistant",
    content: `[Enriched with depth=${result.metadata.enrichmentDepth}, ${result.context.length} context layers]`,
  });
}

async function processInput(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  if (trimmed.startsWith("/")) {
    const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
    const command = cmd!.toLowerCase();

    switch (command) {
      case "platform": {
        const target = args[0] as TargetPlatform | undefined;
        if (!target || !PLATFORMS.includes(target)) {
          console.log(`Usage: /platform <${PLATFORMS.join("|")}>`);
          console.log(`Current: ${platform}`);
        } else {
          platform = target;
          uc = createPipeline(verbose);
          console.log(`Platform switched to: ${platform}`);
        }
        break;
      }
      case "debug":
        verbose = !verbose;
        uc = createPipeline(verbose);
        console.log(`Debug mode: ${verbose ? "ON" : "OFF"}`);
        break;
      case "reset":
        conversation = [];
        console.log("Conversation history cleared.");
        break;
      case "replay":
        if (args.length === 0) {
          console.log("Usage: /replay <path-to-transcript.jsonl>");
        } else {
          await handleReplay(args.join(" "));
        }
        break;
      case "history":
        if (conversation.length === 0) {
          console.log("No conversation history yet.");
        } else {
          for (const turn of conversation) {
            const preview = turn.content.slice(0, 100).replace(/\n/g, " ");
            console.log(`  [${turn.role}] ${preview}${turn.content.length > 100 ? "..." : ""}`);
          }
        }
        break;
      case "help":
        printHelp();
        break;
      case "quit":
      case "exit":
      case "q":
        console.log("Goodbye.");
        process.exit(0);
        break;
      default:
        console.log(`Unknown command: /${command}. Type /help for available commands.`);
    }
  } else {
    await handleMessage(trimmed);
  }
}

async function main(): Promise<void> {
  printBanner();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36m❯\x1b[0m ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    try {
      await processInput(line);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
