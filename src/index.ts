import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { RateLimiter } from "./rate-limiter.js";
import {
  handleGetDocIndex,
  handleGetSubIndex,
  handleReadDocFile,
  handleGetFileToc,
  handleGetChapters,
  handleSearchDocs,
} from "./markdown/handlers.js";
import { MARKDOWN_TOOLS } from "./markdown/tools.js";
import {
  ApiDocIndex,
  handleGetApiIndex,
  handleGetApiType,
  handleGetApiMember,
  handleSearchApi,
  textResult,
} from "./api/handlers.js";
import { API_TOOLS } from "./api/tools.js";
import { XmlDocParser } from "./api/parsers/xmldoc-parser.js";
import { TypeDocParser } from "./api/parsers/typedoc-parser.js";
import type { ApiDocParser } from "./api/types.js";
import { createSourceFromConfig, parseGitHubUrl } from "./source.js";
import type { SourceConfig, DocsSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface ServerConfig {
  name?: string;
  description?: string;
  cacheDir?: string;
  updateInterval?: number;
  port?: number;
  sources?: SourceConfig[];
  /** @deprecated Use sources array instead. */
  docs?: string;
  /** @deprecated Use sources array instead. */
  api?: string;
}

function loadConfig(argv: string[]): ServerConfig {
  const args = argv.slice(2);
  const config: ServerConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config" && i + 1 < args.length) {
      const file = readFileSync(args[++i]!, "utf-8");
      Object.assign(config, JSON.parse(file));
    } else if (arg === "--name" && i + 1 < args.length) {
      config.name = args[++i];
    } else if (arg === "--description" && i + 1 < args.length) {
      config.description = args[++i];
    } else if (arg === "--cache-dir" && i + 1 < args.length) {
      config.cacheDir = args[++i];
    } else if (arg === "--update-interval" && i + 1 < args.length) {
      config.updateInterval = parseInt(args[++i]!, 10);
    } else if (arg === "--port" && i + 1 < args.length) {
      config.port = parseInt(args[++i]!, 10);
    } else if (arg === "--api" && i + 1 < args.length) {
      config.api = args[++i];
    } else if (!arg.startsWith("--")) {
      config.docs = arg;
    }
  }

  return config;
}

const config = loadConfig(process.argv);
const { name, description, cacheDir, updateInterval } = config;
// CLI --port takes precedence, then config file, then HTTP_PLATFORM_PORT (set by IIS httpPlatformHandler)
const port = config.port ?? (process.env.HTTP_PLATFORM_PORT ? parseInt(process.env.HTTP_PLATFORM_PORT, 10) : undefined);

// Build sources list: prefer explicit sources array, fall back to legacy docs/api fields
function resolveSources(cfg: ServerConfig): SourceConfig[] {
  if (cfg.sources && cfg.sources.length > 0) return cfg.sources;

  const sources: SourceConfig[] = [];
  if (cfg.docs) {
    const isGithub = parseGitHubUrl(cfg.docs) !== null;
    sources.push({ type: isGithub ? "github" : "disk", origin: cfg.docs, kind: "docs" });
  }
  if (cfg.api) {
    const isGithub = parseGitHubUrl(cfg.api) !== null;
    sources.push({ type: isGithub ? "github" : "disk", origin: cfg.api, kind: "api" });
  }
  return sources;
}

const sources = resolveSources(config);
if (sources.length === 0) {
  console.error(
    "Usage: markdown-mcp [<docs-folder>] [--config <file>] [--api <api-folder>] [--name <name>] [--description <text>] [--cache-dir <path>] [--update-interval <minutes>] [--port <port>]"
  );
  process.exit(1);
}

const updateIntervalMs = updateInterval ? updateInterval * 60_000 : undefined;
const SERVER_NAME = name ?? "markdown-mcp";

// ─────────────────────────────────────────────────────────────────────────────
// Source setup
// ─────────────────────────────────────────────────────────────────────────────

let mdSource: DocsSource | null = null;
let apiIndex: ApiDocIndex | null = null;

for (const src of sources) {
  const docsSource = createSourceFromConfig(src, cacheDir, updateIntervalMs);
  if (src.kind === "docs") {
    mdSource = docsSource;
  } else if (src.kind === "api") {
    const parsers: ApiDocParser[] = [new XmlDocParser(), new TypeDocParser()];
    apiIndex = new ApiDocIndex(docsSource, parsers);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [];
if (mdSource) TOOLS.push(...MARKDOWN_TOOLS);
if (apiIndex) TOOLS.push(...API_TOOLS);

// ─────────────────────────────────────────────────────────────────────────────
// Server Setup
// ─────────────────────────────────────────────────────────────────────────────

const mcpServer = new McpServer(
  { name: SERVER_NAME, version: "1.0.0", description },
  { capabilities: { tools: {} } }
);

mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

const handleCallTool = async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name, arguments: args } = request.params;

  // Markdown tools
  if (mdSource) {
    switch (name) {
      case "get_doc_index":
        return handleGetDocIndex(mdSource);
      case "get_sub_index":
        return handleGetSubIndex(args as { path: string }, mdSource);
      case "read_doc_file":
        return handleReadDocFile(args as { file_path: string }, mdSource);
      case "get_file_toc":
        return handleGetFileToc(
          args as { file_path: string; include_abstracts?: boolean },
          mdSource
        );
      case "get_chapters":
        return handleGetChapters(
          args as { file_path: string; headings: string[] },
          mdSource
        );
      case "search_docs":
        return handleSearchDocs(
          args as { query: string; path_pattern?: string },
          mdSource
        );
    }
  }

  // API tools
  if (apiIndex) {
    switch (name) {
      case "get_api_index":
        return handleGetApiIndex(apiIndex);
      case "get_api_type":
        return handleGetApiType(args as { type_name: string }, apiIndex);
      case "get_api_member":
        return handleGetApiMember(
          args as { type_name: string; member_name: string },
          apiIndex
        );
      case "search_api":
        return handleSearchApi(args as { query: string }, apiIndex);
    }
  }

  return textResult(`Unknown tool: ${name}`, true);
};

mcpServer.server.setRequestHandler(CallToolRequestSchema, handleCallTool);

if (port) {
  // ── HTTP mode (Streamable HTTP) ──────────────────────────────────────────
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const rateLimiter = new RateLimiter(120, 60_000);

  function getClientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0]!.trim();
    return req.ip ?? "unknown";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/mcp", async (req: any, res: any) => {
    const ip = getClientIp(req);
    if (!rateLimiter.allow(ip)) {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests" },
        id: null,
      });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId]!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };

      // Each HTTP session gets its own McpServer instance sharing the same
      // sources and handlers, so create a fresh one and wire it up.
      const sessionServer = new McpServer(
        { name: SERVER_NAME, version: "1.0.0", description },
        { capabilities: { tools: {} } }
      );
      sessionServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
      }));
      sessionServer.server.setRequestHandler(CallToolRequestSchema, handleCallTool);
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId]!.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: any, res: any) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId]!.handleRequest(req, res);
  });

  app.listen(port, () => {
    console.error(`${SERVER_NAME} MCP Server listening on http://0.0.0.0:${port}/mcp`);
  });

  process.on("SIGINT", async () => {
    for (const sid of Object.keys(transports)) {
      await transports[sid]!.close();
      delete transports[sid];
    }
    process.exit(0);
  });
} else {
  // ── Stdio mode (default) ────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error(`${SERVER_NAME} MCP Server running on stdio`);
}
