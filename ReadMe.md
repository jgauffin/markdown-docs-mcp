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
markdown-mcp <docs-folder-or-github-url> [--name <name>] [--description <text>]
```

| Option | Description |
|---|---|
| `<docs-folder-or-github-url>` | Path to a local documentation directory **or** a GitHub URL (required) |
| `--name <name>` | Documentation title (e.g. "RelaxJS documentation"). Used as the MCP server name and injected into tool descriptions so the AI knows which docs it's browsing. |
| `--description <text>` | Describes what the documentation covers. Sent as the MCP server description. |

The source can be:
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

## Development

```bash
npm run dev        # Watch mode for TypeScript
npm test           # Run tests
npm run test:watch # Watch mode for tests
```

## License

Apache-2.0
