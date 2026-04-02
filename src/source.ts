import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import glob from "fast-glob";
import micromatch from "micromatch";

const execFileAsync = promisify(execFile);

/** Maximum file size that can be read into memory (10 MB). */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// DocsSource Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface DocsSource {
  /** List files matching a glob pattern (relative paths). Accepts | separated patterns for OR. */
  listFiles(pattern: string | string[]): Promise<string[]>;

  /** Read file content by relative path. Throws if not found. */
  readFile(relativePath: string): Promise<string>;

  /**
   * Validate that a relative path is safe (no traversal). Returns normalized path or null.
   * @param appendExtension Extension to append if missing (default ".md"), or false to skip.
   */
  resolvePath(inputPath: string, appendExtension?: string | false): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and validate a relative path.
 * Returns the posix-normalized path or null if it escapes the root.
 */
function safeRelativePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/"));

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized === "." ||
    normalized.includes("\0")
  ) {
    return null;
  }

  let result = normalized;
  if (appendExtension && !result.endsWith(appendExtension)) result += appendExtension;

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// FileSystemSource
// ─────────────────────────────────────────────────────────────────────────────

export class FileSystemSource implements DocsSource {
  private realRoot: string | null = null;

  constructor(private readonly root: string) {}

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = await fs.realpath(this.root);
    }
    return this.realRoot;
  }

  async listFiles(pattern: string | string[]): Promise<string[]> {
    return glob(pattern, { cwd: this.root });
  }

  async readFile(relativePath: string): Promise<string> {
    const absPath = path.join(this.root, relativePath);

    // Resolve symlinks and verify the real path stays within the docs root
    const realPath = await fs.realpath(absPath);
    const realRoot = await this.getRealRoot();
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error("Path escapes document root");
    }

    // Enforce file size limit
    const stat = await fs.stat(realPath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
      );
    }

    return fs.readFile(realPath, "utf-8");
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    const rel = safeRelativePath(inputPath, appendExtension);
    if (!rel) return null;

    const normalizedRoot = path.normalize(this.root);
    const abs = path.resolve(normalizedRoot, rel);

    if (!abs.startsWith(normalizedRoot)) return null;
    return rel;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHubSource
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHubRef {
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

  async listFiles(pattern: string | string[]): Promise<string[]> {
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

    // Enforce file size limit
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
      throw new Error("File too large");
    }

    const content = await res.text();
    if (content.length > MAX_FILE_SIZE) {
      throw new Error("File too large");
    }

    this.fileContentCache.set(relativePath, content);
    return content;
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    return safeRelativePath(inputPath, appendExtension);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitCloneSource
// ─────────────────────────────────────────────────────────────────────────────

const LAST_UPDATED_FILE = ".last-updated";

export class GitCloneSource implements DocsSource {
  private readonly ref: GitHubRef;
  private readonly cloneDir: string;
  private readonly docsRoot: string;
  private readonly updateIntervalMs: number;
  private ensured = false;
  private realRoot: string | null = null;

  constructor(ref: GitHubRef, cacheDir: string, updateIntervalMs: number) {
    this.ref = ref;
    // e.g. ~/.cache/markdown-mcp/owner/repo/branch
    this.cloneDir = path.join(cacheDir, ref.owner, ref.repo, ref.branch);
    this.docsRoot = ref.basePath
      ? path.join(this.cloneDir, ref.basePath)
      : this.cloneDir;
    this.updateIntervalMs = updateIntervalMs;
  }

  private cloneUrl(): string {
    const { owner, repo } = this.ref;
    if (process.env.GITHUB_TOKEN) {
      return `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${owner}/${repo}.git`;
    }
    return `https://github.com/${owner}/${repo}.git`;
  }

  private async isCloned(): Promise<boolean> {
    try {
      await fs.access(path.join(this.cloneDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  private async isStale(): Promise<boolean> {
    try {
      const tsFile = path.join(this.cloneDir, LAST_UPDATED_FILE);
      const content = await fs.readFile(tsFile, "utf-8");
      const lastUpdated = parseInt(content.trim(), 10);
      return Date.now() - lastUpdated > this.updateIntervalMs;
    } catch {
      return true;
    }
  }

  private async writeTimestamp(): Promise<void> {
    const tsFile = path.join(this.cloneDir, LAST_UPDATED_FILE);
    await fs.writeFile(tsFile, String(Date.now()), "utf-8");
  }

  private async ensureClone(): Promise<void> {
    if (this.ensured) return;

    if (await this.isCloned()) {
      if (await this.isStale()) {
        console.error(`Updating cached clone: ${this.cloneDir}`);
        try {
          await execFileAsync("git", ["-C", this.cloneDir, "pull", "--ff-only"]);
        } catch (err) {
          console.error(`Git pull failed, using existing cache: ${err}`);
        }
        await this.writeTimestamp();
      }
    } else {
      console.error(`Cloning ${this.ref.owner}/${this.ref.repo}@${this.ref.branch} into ${this.cloneDir}`);
      await fs.mkdir(this.cloneDir, { recursive: true });
      await execFileAsync("git", [
        "clone",
        "--depth", "1",
        "--branch", this.ref.branch,
        "--single-branch",
        this.cloneUrl(),
        this.cloneDir,
      ]);
      await this.writeTimestamp();
    }

    this.ensured = true;
  }

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = await fs.realpath(this.docsRoot);
    }
    return this.realRoot;
  }

  async listFiles(pattern: string | string[]): Promise<string[]> {
    await this.ensureClone();
    return glob(pattern, { cwd: this.docsRoot });
  }

  async readFile(relativePath: string): Promise<string> {
    await this.ensureClone();
    const absPath = path.join(this.docsRoot, relativePath);

    // Resolve symlinks and verify the real path stays within the docs root
    const realPath = await fs.realpath(absPath);
    const realRoot = await this.getRealRoot();
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error("Path escapes document root");
    }

    // Enforce file size limit
    const stat = await fs.stat(realPath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
      );
    }

    return fs.readFile(realPath, "utf-8");
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    return safeRelativePath(inputPath, appendExtension);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source config
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceConfig {
  /** "disk" for local directories, "github" for GitHub repositories. */
  type: "disk" | "github";
  /** Local path or GitHub URL. */
  origin: string;
  /** What the source provides. */
  kind: "docs" | "api";
  /** Subfolder within the origin (especially useful for GitHub repos). */
  folder?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSource(
  docsFolder: string,
  cacheDir?: string,
  updateIntervalMs?: number,
): DocsSource {
  const ghRef = parseGitHubUrl(docsFolder);
  if (ghRef) {
    if (cacheDir) {
      return new GitCloneSource(ghRef, cacheDir, updateIntervalMs ?? 60 * 60_000);
    }
    return new GitHubSource(ghRef);
  }
  return new FileSystemSource(path.resolve(docsFolder));
}

export function createSourceFromConfig(
  source: SourceConfig,
  cacheDir?: string,
  updateIntervalMs?: number,
): DocsSource {
  if (source.type === "github") {
    const ghRef = parseGitHubUrl(source.origin);
    if (!ghRef) throw new Error(`Invalid GitHub URL: ${source.origin}`);

    // Append folder to the repo's basePath
    if (source.folder) {
      ghRef.basePath = ghRef.basePath
        ? `${ghRef.basePath}/${source.folder}`
        : source.folder;
    }

    if (cacheDir) {
      return new GitCloneSource(ghRef, cacheDir, updateIntervalMs ?? 60 * 60_000);
    }
    return new GitHubSource(ghRef);
  }

  // Disk source
  const dir = source.folder
    ? path.resolve(source.origin, source.folder)
    : path.resolve(source.origin);
  return new FileSystemSource(dir);
}
