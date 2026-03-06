import fs from "fs/promises";
import path from "path";
import glob from "fast-glob";
import micromatch from "micromatch";

// ─────────────────────────────────────────────────────────────────────────────
// DocsSource Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface DocsSource {
  /** List all markdown files matching a glob pattern (relative paths). */
  listFiles(pattern: string): Promise<string[]>;

  /** Read file content by relative path. Throws if not found. */
  readFile(relativePath: string): Promise<string>;

  /** Validate that a relative path is safe (no traversal). Returns normalized path or null. */
  resolvePath(inputPath: string): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FileSystemSource
// ─────────────────────────────────────────────────────────────────────────────

export class FileSystemSource implements DocsSource {
  constructor(private readonly root: string) {}

  async listFiles(pattern: string): Promise<string[]> {
    return glob(pattern, { cwd: this.root });
  }

  async readFile(relativePath: string): Promise<string> {
    const absPath = path.join(this.root, relativePath);
    return fs.readFile(absPath, "utf-8");
  }

  resolvePath(inputPath: string): string | null {
    let rel = inputPath;
    if (!rel.endsWith(".md")) rel += ".md";

    const normalizedRoot = path.normalize(this.root);
    const abs = path.resolve(normalizedRoot, rel);

    if (!abs.startsWith(normalizedRoot)) return null;
    return rel;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHubSource
// ─────────────────────────────────────────────────────────────────────────────

interface GitHubRef {
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
}

/**
 * Parse a GitHub URL into owner, repo, branch, and sub-path.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/path/to/docs
 */
export function parseGitHubUrl(url: string): GitHubRef | null {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(\/.*)?)?$/
  );
  if (!m) return null;

  return {
    owner: m[1]!,
    repo: m[2]!,
    branch: m[3] ?? "main",
    basePath: m[4] ? m[4].replace(/^\//, "") : "",
  };
}

export class GitHubSource implements DocsSource {
  private readonly ref: GitHubRef;
  private fileListCache: string[] | null = null;
  private fileContentCache = new Map<string, string>();

  constructor(ref: GitHubRef) {
    this.ref = ref;
  }

  private get rawBase(): string {
    const { owner, repo, branch } = this.ref;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  }

  private get apiBase(): string {
    const { owner, repo } = this.ref;
    return `https://api.github.com/repos/${owner}/${repo}`;
  }

  private fullPath(relativePath: string): string {
    return this.ref.basePath
      ? `${this.ref.basePath}/${relativePath}`
      : relativePath;
  }

  /** Fetch the recursive file tree from GitHub and filter to our basePath. */
  private async fetchFileList(): Promise<string[]> {
    if (this.fileListCache) return this.fileListCache;

    const url = `${this.apiBase}/git/trees/${this.ref.branch}?recursive=1`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "markdown-mcp",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (!res.ok) {
      throw new Error(
        `GitHub API error (${res.status}): ${await res.text()}`
      );
    }

    const data = (await res.json()) as {
      tree: Array<{ path: string; type: string }>;
    };

    const prefix = this.ref.basePath ? this.ref.basePath + "/" : "";
    const files: string[] = [];
    for (const entry of data.tree) {
      if (entry.type !== "blob") continue;
      if (prefix && !entry.path.startsWith(prefix)) continue;
      // Make path relative to basePath
      const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
      files.push(rel);
    }

    this.fileListCache = files;
    return files;
  }

  async listFiles(pattern: string): Promise<string[]> {
    const allFiles = await this.fetchFileList();
    return micromatch(allFiles, pattern);
  }

  async readFile(relativePath: string): Promise<string> {
    const cached = this.fileContentCache.get(relativePath);
    if (cached !== undefined) return cached;

    const fullPath = this.fullPath(relativePath);
    const url = `${this.rawBase}/${fullPath}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "markdown-mcp",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${relativePath} (${res.status})`);
    }

    const content = await res.text();
    this.fileContentCache.set(relativePath, content);
    return content;
  }

  resolvePath(inputPath: string): string | null {
    let rel = inputPath;
    if (!rel.endsWith(".md")) rel += ".md";

    // Block directory traversal
    const normalized = rel.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("../") ||
      normalized.includes("/../")
    ) {
      return null;
    }

    return normalized;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSource(docsFolder: string): DocsSource {
  const ghRef = parseGitHubUrl(docsFolder);
  if (ghRef) {
    return new GitHubSource(ghRef);
  }
  return new FileSystemSource(path.resolve(docsFolder));
}
