# Markdown MCP Server

An MCP (Model Context Protocol) server for browsing and searching Markdown documentation.

## Why use this instead of direct file access?

|  | Direct file access | Markdown MCP |
|---|---|---|
| **Security** | Agent can read/write anywhere on the filesystem | Sandboxed to a single docs directory with traversal protection |
| **Discovery** | Agent must scan directories and read files one-by-one | `get_doc_index` provides instant overview of all available docs |
| **Search** | Agent greps files manually, burning context | `search_docs` finds content across all files with regex support |
| **Large files** | Entire file loaded into context window | `get_file_toc` + `get_chapters` lets the agent read only the sections it needs |
| **Source** | Local files only | Local directories or GitHub URLs — no cloning required |

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
markdown-mcp <docs-folder-or-github-url> [--config <file>] [--name <name>] [--description <text>] [--port <port>]
```

| Option | Description |
|---|---|
| `<docs-folder-or-github-url>` | Path to a local documentation directory **or** a GitHub URL (required) |
| `--config <file>` | Load settings from a JSON config file (see below). CLI flags override config file values. |
| `--name <name>` | Documentation title (e.g. "RelaxJS documentation"). Used as the MCP server name and injected into tool descriptions so the AI knows which docs it's browsing. |
| `--description <text>` | Describes what the documentation covers. Sent as the MCP server description. |
| `--port <port>` | Run as an HTTP server on this port instead of stdio. See [HTTP mode](#http-mode). |

### Config file

Instead of command-line arguments, you can use a JSON config file with a `sources` array:

```json
{
  "name": "My Project",
  "description": "Usage and API docs for My Project",
  "cacheDir": "./cache",
  "updateInterval": 30,
  "sources": [
    { "type": "disk", "origin": "./docs", "kind": "docs" },
    { "type": "disk", "origin": "./api-docs", "kind": "api" }
  ]
}
```

Each source entry has:

| Field | Description |
|---|---|
| `type` | `"disk"` for local directories, `"github"` for GitHub repositories |
| `origin` | Local path or GitHub URL |
| `kind` | `"docs"` for Markdown documentation, `"api"` for API documentation |
| `folder` | *(optional)* Subfolder within the origin |

The `folder` field is especially useful when both docs and API live in the same GitHub repo — the repo is only cloned once:

```json
{
  "name": "My Project",
  "cacheDir": "./cache",
  "sources": [
    { "type": "github", "origin": "https://github.com/user/my-project", "kind": "docs", "folder": "docs" },
    { "type": "github", "origin": "https://github.com/user/my-project", "kind": "api", "folder": "api" }
  ]
}
```

```bash
markdown-mcp --config mcp-config.json
```

CLI arguments override config file values when both are provided. The legacy `docs` and `api` top-level fields still work for simple setups but `sources` is preferred.

The source `origin` can be:
- A **local directory** — e.g. `./docs` or `/path/to/docs`
- A **GitHub URL** — e.g. `https://github.com/owner/repo/tree/main/docs`

### Supported GitHub URL formats

| URL | Resolved as |
|---|---|
| `https://github.com/owner/repo` | Root of `main` branch |
| `https://github.com/owner/repo/tree/branch` | Root of specified branch |
| `https://github.com/owner/repo/tree/branch/path/to/docs` | Subfolder of specified branch |

For private repositories, set the `GITHUB_TOKEN` environment variable.

### Examples

Local directory:

```bash
node dist/index.js ./docs
```

GitHub repository (docs subfolder):

```bash
node dist/index.js https://github.com/user/my-project/tree/main/docs --name "My Project"
```

With title and description:

```bash
node dist/index.js ./docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

### Claude Code

Add as a project-scoped server (local):

```bash
claude mcp add relaxjs-docs -- node /path/to/markdown-mcp/dist/index.js /path/to/relaxjs/docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

Add as a project-scoped server (GitHub):

```bash
claude mcp add relaxjs-docs -- node /path/to/markdown-mcp/dist/index.js https://github.com/user/relaxjs/tree/main/docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

Or add globally (available in all projects):

```bash
claude mcp add --scope user relaxjs-docs -- node /path/to/markdown-mcp/dist/index.js /path/to/relaxjs/docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "relaxjs-docs": {
      "command": "node",
      "args": [
        "/path/to/markdown-mcp/dist/index.js",
        "https://github.com/user/relaxjs/tree/main/docs",
        "--name", "RelaxJS",
        "--description", "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
      ]
    }
  }
}
```

For private repos, add the token to the environment:

```json
{
  "mcpServers": {
    "private-docs": {
      "command": "node",
      "args": [
        "/path/to/markdown-mcp/dist/index.js",
        "https://github.com/org/private-repo/tree/main/docs",
        "--name", "Private Docs"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

## HTTP mode

By default the server uses stdio, which is what MCP clients like Claude Code and Claude Desktop expect. To expose the server over HTTP instead (e.g. for public access behind a reverse proxy), add `--port`:

```bash
node dist/index.js ./docs --name "My Docs" --port 3000
```

The server will listen on `http://0.0.0.0:<port>/mcp` using the MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport. Clients connect by pointing their MCP HTTP configuration at that URL.

### Hosting with IIS (httpPlatformHandler)

IIS can manage the Node process directly using `httpPlatformHandler` — no separate reverse proxy modules needed. IIS starts the process, assigns it a port via `HTTP_PLATFORM_PORT`, and forwards all matching requests to it. The server reads this variable automatically.

**Prerequisites:** The HttpPlatformHandler module ships with IIS 10+. On older versions, install it from the [IIS downloads page](https://www.iis.net/downloads/microsoft/httpplatformhandler).

**1. Create an IIS application**

In IIS Manager, create a new Application (or virtual directory) under your site — for example with alias `mcp-docs` pointing to the folder that contains `web.config` below.

**2. Add a `web.config`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="httpPlatformHandler"
           path="*" verb="*"
           modules="httpPlatformHandler"
           resourceType="Unspecified" />
    </handlers>
    <httpPlatform processPath="node"
                  arguments="d:\path\to\markdown-mcp\dist\index.js --config d:\path\to\mcp-config.json"
                  startupTimeLimit="60"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\node.log">
      <environmentVariables>
        <environmentVariable name="NODE_ENV" value="production" />
      </environmentVariables>
    </httpPlatform>
  </system.webServer>
</configuration>
```

IIS sets `HTTP_PLATFORM_PORT` automatically — the server picks it up without needing `port` in the config file. Adjust the `processPath` if `node` is not on the system PATH (use the full path, e.g. `C:\Program Files\nodejs\node.exe`).

**3. Client configuration**

Agents connect using the public URL:

```json
{
  "mcpServers": {
    "my-docs": {
      "type": "streamableHttp",
      "url": "https://yourserver.com/mcp-docs/mcp"
    }
  }
}
```

## Development

```bash
npm run dev        # Watch mode for TypeScript
npm test           # Run tests
npm run test:watch # Watch mode for tests
```

## License

Apache-2.0
