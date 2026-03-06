import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  handleGetDocIndex,
  handleReadDocFile,
  handleGetFileToc,
  handleGetChapters,
  handleSearchDocs,
  textResult,
} from "./handlers.js";
import { createSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let docsFolder: string | undefined;
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (arg === "--description" && i + 1 < args.length) {
      description = args[++i];
    } else if (!arg.startsWith("--")) {
      docsFolder = arg;
    }
  }

  return { docsFolder, name, description };
}

const { docsFolder, name, description } = parseArgs(process.argv);
if (!docsFolder) {
  console.error(
    "Usage: markdown-mcp <docs-folder-or-github-url> [--name <name>] [--description <text>]"
  );
  process.exit(1);
}

const source = createSource(docsFolder);
const SERVER_NAME = name ?? "markdown-mcp";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions (JSON Schema for MCP protocol)
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_doc_index",
    description:
      "Returns a list of all available documentation files with their title and abstract.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_doc_file",
    description: "Reads the full content of a documentation file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Relative path to the doc file (e.g., 'components/button.md')",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_file_toc",
    description:
      "Returns the Table of Contents (headings) of a file. Use this for large docs to find specific sections before reading them with get_chapters.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        include_abstracts: {
          type: "boolean",
          description:
            "Include the first paragraph after each heading as an abstract (default: false)",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_chapters",
    description:
      "Returns the content of specific chapters (sections) from a doc file. Use after get_file_toc to read selected sections.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        headings: {
          type: "array",
          items: { type: "string" },
          description:
            "List of heading names to extract (e.g., ['Authentication', 'Error Handling'])",
        },
      },
      required: ["file_path", "headings"],
    },
  },
  {
    name: "search_docs",
    description:
      "Search documentation using regex (case insensitive). Can be scoped using glob patterns.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Regex pattern to search for (case insensitive)",
        },
        path_pattern: {
          type: "string",
          description:
            "Glob pattern to filter files (e.g., 'api/**', 'components/*.md'). Defaults to '**/*.md'",
        },
      },
      required: ["query"],
    },
  },
];

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

mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_doc_index":
      return handleGetDocIndex(source);
    case "read_doc_file":
      return handleReadDocFile(args as { file_path: string }, source);
    case "get_file_toc":
      return handleGetFileToc(
        args as { file_path: string; include_abstracts?: boolean },
        source
      );
    case "get_chapters":
      return handleGetChapters(
        args as { file_path: string; headings: string[] },
        source
      );
    case "search_docs":
      return handleSearchDocs(
        args as { query: string; path_pattern?: string },
        source
      );
    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error(`${SERVER_NAME} MCP Server running on stdio`);
