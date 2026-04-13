import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  handleGetDocIndex,
  handleGetSubIndex,
  handleReadDocFile,
  handleGetFileToc,
  handleGetChapters,
  handleSearchDocs,
} from "../src/markdown/handlers.js";
import {
  GitCloneSource,
  GitHubSource,
  createSourceFromConfig,
  parseGitHubUrl,
} from "../src/source.js";

// Integration tests against the live https://github.com/relax-js/core repo (docs folder).
// These hit the real GitHub API + raw.githubusercontent.com, so they require network
// access. The tree is fetched once per GitHubSource; file content is read via raw,
// which does not count against the GitHub API rate limit.
//
// Set SKIP_INTEGRATION=1 to skip, or GITHUB_TOKEN to raise the API rate limit.

const DOCS_URL = "https://github.com/relax-js/core/tree/main/docs";
const shouldRun = process.env.SKIP_INTEGRATION !== "1";

describe.runIf(shouldRun)("integration: relax-js/core docs (GitHubSource)", () => {
  let source: GitHubSource;

  beforeAll(() => {
    const ref = parseGitHubUrl(DOCS_URL);
    if (!ref) throw new Error(`Failed to parse URL: ${DOCS_URL}`);
    expect(ref).toEqual({
      owner: "relax-js",
      repo: "core",
      branch: "main",
      basePath: "docs",
    });
    source = new GitHubSource(ref);
  }, 30_000);

  it("lists markdown files filtered to the docs/ subfolder", async () => {
    const files = await source.listFiles("**/*.md");
    expect(files.length).toBeGreaterThan(20);
    // basePath stripped — no path should start with "docs/"
    expect(files.every((f) => !f.startsWith("docs/"))).toBe(true);
    // Known top-level docs
    expect(files).toContain("Architecture.md");
    expect(files).toContain("GettingStarted.md");
    // Known nested docs
    expect(files).toContain("forms/forms.md");
    expect(files).toContain("routing/Routing.md");
  }, 30_000);

  it("get_doc_index returns a populated index with known entries", async () => {
    const result = await handleGetDocIndex(source);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("doc_index:");
    expect(text).toContain('"Architecture.md"');
    expect(text).toContain('"GettingStarted.md"');
    // Sanity-check that abstracts are present
    expect(text).toContain("abstract:");
  }, 60_000);

  it("get_sub_index lists files under a known folder", async () => {
    const result = await handleGetSubIndex({ path: "forms" }, source);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("forms/forms.md");
    expect(text).toContain("forms/validation.md");
    // Should not include files from other folders
    expect(text).not.toContain("routing/Routing.md");
  }, 30_000);

  it("read_doc_file returns raw markdown for a known file", async () => {
    const result = await handleReadDocFile({ file_path: "Architecture.md" }, source);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    // First heading of Architecture.md
    expect(text).toMatch(/^#\s+/m);
    expect(text.length).toBeGreaterThan(100);
  }, 30_000);

  it("read_doc_file returns a clear error for a missing file", async () => {
    const result = await handleReadDocFile(
      { file_path: "does-not-exist-xyz.md" },
      source,
    );
    expect(result.isError).toBe(true);
  }, 30_000);

  it("get_file_toc returns headings for a known file", async () => {
    const result = await handleGetFileToc({ file_path: "Architecture.md" }, source);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("toc:");
    expect(text).toContain('file: "Architecture.md"');
    expect(text).toContain("headings:");
  }, 30_000);

  it("get_chapters extracts requested sections from a known file", async () => {
    const tocResult = await handleGetFileToc({ file_path: "Architecture.md" }, source);
    const tocText = tocResult.content[0]!.text;
    // Pull the first non-title (level > 1) heading out of the YAML TOC so we
    // don't hard-code headings that may change upstream.
    const headingMatch = tocText.match(/title:\s*"([^"]+)"\s*\n\s*level:\s*2/);
    expect(headingMatch, "expected at least one level-2 heading in TOC").toBeTruthy();
    const heading = headingMatch![1]!;

    const result = await handleGetChapters(
      { file_path: "Architecture.md", headings: [heading] },
      source,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("chapters:");
    expect(text).toContain(`"${heading}"`);
    expect(text).toContain("content: |");
  }, 30_000);

  it("search_docs finds matches across the repo", async () => {
    const result = await handleSearchDocs({ query: "relaxjs" }, source);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("search:");
    expect(text).toContain("results:");
    // relax-js/core docs reference the framework name heavily
    expect(text).not.toBe("No matches found.");
  }, 60_000);

  it("search_docs honours a folder-scoped path_pattern", async () => {
    const result = await handleSearchDocs(
      { query: "form", path_pattern: "forms/" },
      source,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("forms/");
    // Other folders should not appear in the result listing
    expect(text).not.toContain("routing/");
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// GitCloneSource — same repo, but mirrored/cloned to a local cache dir.
// Requires `git` on PATH. Uses a unique temp cacheDir so runs don't interfere.
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(shouldRun)("integration: relax-js/core docs (GitCloneSource)", () => {
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-docs-clone-"));
  });

  afterAll(async () => {
    if (cacheDir) {
      await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("clones the repo and finds markdown files under docs/", async () => {
    const ref = parseGitHubUrl(DOCS_URL)!;
    const source = new GitCloneSource(ref, cacheDir, 60 * 60_000);

    const files = await source.listFiles("**/*.md");
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("Architecture.md");
    expect(files).toContain("forms/forms.md");

    // Clone is laid out at <cacheDir>/<owner>/<repo>/<branch>
    const cloneRoot = path.join(cacheDir, "relax-js", "core", "main");
    await expect(fs.access(path.join(cloneRoot, ".git"))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(cloneRoot, "docs", "Architecture.md")),
    ).resolves.toBeUndefined();
  }, 120_000);

  it("get_doc_index works end-to-end against the cloned copy", async () => {
    const ref = parseGitHubUrl(DOCS_URL)!;
    const source = new GitCloneSource(ref, cacheDir, 60 * 60_000);

    const result = await handleGetDocIndex(source);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("doc_index:");
    expect(text).toContain('"Architecture.md"');
    expect(text).toContain("abstract:");
  }, 120_000);

  it("supports the config-file shape (type: github + folder: docs)", async () => {
    const source = createSourceFromConfig(
      {
        type: "github",
        origin: "https://github.com/relax-js/core",
        kind: "docs",
        folder: "docs",
      },
      cacheDir,
      60 * 60_000,
    );

    const files = await source.listFiles("**/*.md");
    expect(files).toContain("Architecture.md");
    expect(files).toContain("forms/forms.md");
    // basePath should be stripped — nothing should retain the "docs/" prefix
    expect(files.every((f) => !f.startsWith("docs/"))).toBe(true);
  }, 120_000);

  it("reuses an existing clone on a second source instance (cache is fresh)", async () => {
    const ref = parseGitHubUrl(DOCS_URL)!;
    const cloneRoot = path.join(cacheDir, "relax-js", "core", "main");
    const tsFile = path.join(cloneRoot, ".last-updated");

    // Prior tests already cloned the repo; capture the existing timestamp.
    const before = await fs.readFile(tsFile, "utf-8");

    const source = new GitCloneSource(ref, cacheDir, 60 * 60_000);
    const files = await source.listFiles("**/*.md");
    expect(files.length).toBeGreaterThan(20);

    // Timestamp should be untouched when the cache is still fresh.
    const after = await fs.readFile(tsFile, "utf-8");
    expect(after).toBe(before);
  }, 60_000);
});
