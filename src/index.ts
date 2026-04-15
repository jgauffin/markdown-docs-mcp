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
import {
  SchemaIndex,
  handleListSchemas,
  handleListDefinitions,
  handleGetDefinition,
  handleSearchDefinitions,
  handleSearchAllSchemas,
} from "./schema/handlers.js";
import { SCHEMA_TOOLS } from "./schema/tools.js";
import { createSourceFromConfig, parseGitHubUrl } from "./source.js";
import type { SourceConfig, DocsSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface LibraryConfig {
  name: string;
  description?: string;
  sources: SourceConfig[];
}

interface ServerConfig {
  name?: string;
  description?: string;
  cacheDir?: string;
  updateInterval?: number;
  port?: number;

  /** New multi-library config. */
  libraries?: LibraryConfig[];

  /** @deprecated Legacy single-library fields. */
  sources?: SourceConfig[];
  /** @deprecated Use libraries instead. */
  docs?: string;
  /** @deprecated Use libraries instead. */
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
const port = config.port ?? (process.env.HTTP_PLATFORM_PORT ? parseInt(process.env.HTTP_PLATFORM_PORT, 10) : undefined);

/**
 * Resolve libraries from config. Supports three input shapes:
 *   1. New:     { libraries: [{ name, sources: [...] }, ...] }
 *   2. Legacy:  { sources: [...] }              → one implicit library
 *   3. Legacy:  { docs, api }                   → one implicit library
 */
function resolveLibraries(cfg: ServerConfig): LibraryConfig[] {
  if (cfg.libraries && cfg.libraries.length > 0) return cfg.libraries;

  // Implicit single library from legacy config
  const implicitName = cfg.name ?? "default";
  const implicitDescription = cfg.description;

  if (cfg.sources && cfg.sources.length > 0) {
    return [{ name: implicitName, description: implicitDescription, sources: cfg.sources }];
  }

  const sources: SourceConfig[] = [];
  if (cfg.docs) {
    const isGithub = parseGitHubUrl(cfg.docs) !== null;
    sources.push({ type: isGithub ? "github" : "disk", origin: cfg.docs, kind: "docs" });
  }
  if (cfg.api) {
    const isGithub = parseGitHubUrl(cfg.api) !== null;
    sources.push({ type: isGithub ? "github" : "disk", origin: cfg.api, kind: "api" });
  }
  if (sources.length === 0) return [];
  return [{ name: implicitName, description: implicitDescription, sources }];
}

function validateLibraryName(libName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(libName)) {
    throw new Error(
      `Invalid library name: "${libName}". Must start with alphanumeric and contain only letters, digits, _, -, .`,
    );
  }
}

const libraryConfigs = resolveLibraries(config);
if (libraryConfigs.length === 0) {
  console.error(
    "Usage: markdown-mcp [<docs-folder>] [--config <file>] [--api <api-folder>] [--name <name>] [--description <text>] [--cache-dir <path>] [--update-interval <minutes>] [--port <port>]",
  );
  process.exit(1);
}

const names = new Set<string>();
for (const lib of libraryConfigs) {
  validateLibraryName(lib.name);
  if (names.has(lib.name)) throw new Error(`Duplicate library name: "${lib.name}"`);
  names.add(lib.name);
}

const updateIntervalMs = updateInterval ? updateInterval * 60_000 : undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Library setup — load each library's sources into its own handlers
// ─────────────────────────────────────────────────────────────────────────────

interface Library {
  name: string;
  description?: string;
  mdSource?: DocsSource;
  apiIndex?: ApiDocIndex;
  schemaIndex?: SchemaIndex;
}

const libraries = new Map<string, Library>();

for (const lib of libraryConfigs) {
  const entry: Library = { name: lib.name, description: lib.description };
  for (const src of lib.sources) {
    console.error(
      `[init] Library "${lib.name}": setting up ${src.kind} source: ${src.type} ${src.origin}${src.folder ? ` (folder: ${src.folder})` : ""}`,
    );
    const docsSource = createSourceFromConfig(src, cacheDir, updateIntervalMs);
    if (src.kind === "docs") {
      entry.mdSource = docsSource;
    } else if (src.kind === "api") {
      const parsers: ApiDocParser[] = [new XmlDocParser(), new TypeDocParser()];
      entry.apiIndex = new ApiDocIndex(docsSource, parsers);
    } else if (src.kind === "schema") {
      entry.schemaIndex = new SchemaIndex(docsSource);
    }
  }
  libraries.set(lib.name, entry);
}

const libraryList = [...libraries.values()];
const hasAnyDocs = libraryList.some((l) => l.mdSource);
const hasAnyApi = libraryList.some((l) => l.apiIndex);
const hasAnySchema = libraryList.some((l) => l.schemaIndex);

const singleLibrary = libraryList.length === 1 ? libraryList[0]! : null;

// ─────────────────────────────────────────────────────────────────────────────
// Server name / description
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_NAME = name ?? "markdown-mcp";

function buildServerDescription(): string {
  const summaries = libraryList.map((l) =>
    l.description ? `${l.name} (${l.description})` : l.name,
  );
  const hostedLine = summaries.length === 1
    ? `Hosts: ${summaries[0]}.`
    : `Hosts ${summaries.length} libraries: ${summaries.join(", ")}.`;

  if (description) return `${description} ${hostedLine}`;
  return hostedLine;
}

const SERVER_DESCRIPTION = buildServerDescription();
console.error(`[init] ${SERVER_DESCRIPTION}`);

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions — inject `library` parameter where needed
// ─────────────────────────────────────────────────────────────────────────────

const libraryNames = libraryList.map((l) => l.name);
const libraryEnum = libraryNames;

function injectLibraryParam(tools: Tool[]): Tool[] {
  // Only inject if multiple libraries — single-library mode keeps tools simple.
  if (singleLibrary) return tools;

  const libDesc = `Library to query. One of: ${libraryNames.join(", ")}`;

  return tools.map((t) => {
    const schema = t.inputSchema as {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      ...t,
      inputSchema: {
        type: "object",
        properties: {
          library: { type: "string", description: libDesc, enum: libraryEnum },
          ...(schema.properties ?? {}),
        },
        required: ["library", ...(schema.required ?? [])],
      },
    };
  });
}

const LIST_LIBRARIES_TOOL: Tool = {
  name: "list_libraries",
  description:
    "List all libraries available on this server with their descriptions and which tool groups they expose (docs / api / schema).",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const TOOLS: Tool[] = [];
if (libraryList.length > 1) TOOLS.push(LIST_LIBRARIES_TOOL);
if (hasAnyDocs) TOOLS.push(...injectLibraryParam(MARKDOWN_TOOLS));
if (hasAnyApi) TOOLS.push(...injectLibraryParam(API_TOOLS));
if (hasAnySchema) TOOLS.push(...injectLibraryParam(SCHEMA_TOOLS));

console.error(
  `[init] ${libraries.size} libraries, ${TOOLS.length} tools (docs:${hasAnyDocs} api:${hasAnyApi} schema:${hasAnySchema})`,
);

// ─────────────────────────────────────────────────────────────────────────────
// Library resolution for tool calls
// ─────────────────────────────────────────────────────────────────────────────

function resolveLibrary(
  args: Record<string, unknown> | undefined,
): { library: Library } | { error: string } {
  const requested = args?.library;
  if (typeof requested === "string") {
    const lib = libraries.get(requested);
    if (!lib) {
      return { error: `Unknown library: "${requested}". Available: ${libraryNames.join(", ")}` };
    }
    return { library: lib };
  }
  if (singleLibrary) return { library: singleLibrary };
  return { error: `library parameter is required. Available: ${libraryNames.join(", ")}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

const mcpServer = new McpServer(
  { name: SERVER_NAME, version: "1.0.0", description: SERVER_DESCRIPTION },
  { capabilities: { tools: {} } },
);

mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

const handleCallTool = async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name: toolName, arguments: args } = request.params;
  console.error(`[tool] ${toolName} called`);

  if (toolName === "list_libraries") {
    const payload = libraryList.map((l) => ({
      name: l.name,
      description: l.description ?? null,
      capabilities: {
        docs: !!l.mdSource,
        api: !!l.apiIndex,
        schema: !!l.schemaIndex,
      },
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      isError: false,
    };
  }

  const resolved = resolveLibrary(args);
  if ("error" in resolved) return textResult(`error: ${resolved.error}`, true);
  const { library } = resolved;

  // Markdown tools
  if (library.mdSource) {
    switch (toolName) {
      case "get_doc_index":
        return handleGetDocIndex(library.mdSource);
      case "get_sub_index":
        return handleGetSubIndex(args as { path: string }, library.mdSource);
      case "read_doc_file":
        return handleReadDocFile(args as { file_path: string }, library.mdSource);
      case "get_file_toc":
        return handleGetFileToc(
          args as { file_path: string; include_abstracts?: boolean },
          library.mdSource,
        );
      case "get_chapters":
        return handleGetChapters(
          args as { file_path: string; headings: string[] },
          library.mdSource,
        );
      case "search_docs":
        return handleSearchDocs(
          args as { query: string; path_pattern?: string },
          library.mdSource,
        );
    }
  }

  // API tools
  if (library.apiIndex) {
    switch (toolName) {
      case "get_api_index":
        return handleGetApiIndex(args as { package?: string }, library.apiIndex);
      case "get_api_type":
        return handleGetApiType(
          args as { type_name: string; package?: string },
          library.apiIndex,
        );
      case "get_api_member":
        return handleGetApiMember(
          args as { type_name: string; member_name: string; package?: string },
          library.apiIndex,
        );
      case "search_api":
        return handleSearchApi(
          args as { query: string; package?: string },
          library.apiIndex,
        );
    }
  }

  // Schema tools
  if (library.schemaIndex) {
    switch (toolName) {
      case "list_schemas":
        return handleListSchemas(library.schemaIndex);
      case "list_definitions":
        return handleListDefinitions(args as { schema: string }, library.schemaIndex);
      case "get_definition":
        return handleGetDefinition(
          args as { schema: string; definition: string },
          library.schemaIndex,
        );
      case "search_definitions":
        return handleSearchDefinitions(
          args as { schema: string; keyword: string },
          library.schemaIndex,
        );
      case "search_all_schemas":
        return handleSearchAllSchemas(args as { keyword: string }, library.schemaIndex);
    }
  }

  return textResult(
    `error: Tool "${toolName}" is not supported by library "${library.name}"`,
    true,
  );
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
    const method = Array.isArray(req.body)
      ? req.body.map((r: { method?: string }) => r.method).join(", ")
      : req.body?.method ?? "unknown";
    console.error(`[http] POST /mcp method=${method}`);
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

      const sessionServer = new McpServer(
        { name: SERVER_NAME, version: "1.0.0", description: SERVER_DESCRIPTION },
        { capabilities: { tools: {} } },
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
