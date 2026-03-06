import type { DocsSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts markdown headers as a table of contents.
 * When includeAbstracts is true, the first non-empty, non-heading line after each heading is appended.
 */
export function extractToc(content: string, includeAbstracts = false): string[] {
  const toc: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+(.*)/);
    if (!match?.[1] || match[2] === undefined) continue;

    const indent = "  ".repeat(match[1].length - 1);
    let abstract = "";
    if (includeAbstracts) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!.trim();
        if (next === "") continue;
        if (next.startsWith("#")) break;
        abstract = next;
        break;
      }
    }

    const entry = abstract
      ? `${indent}- [Line ${i + 1}] ${match[2]} — ${abstract}`
      : `${indent}- [Line ${i + 1}] ${match[2]}`;
    toc.push(entry);
  }

  return toc;
}

/**
 * Extracts the content of specific chapters (sections) by heading name.
 * Each chapter includes everything from the heading to the next heading of the same or higher level.
 */
export function extractChapters(content: string, headings: string[]): Map<string, string> {
  const lines = content.split("\n");
  const result = new Map<string, string>();
  const lowerHeadings = headings.map(h => h.toLowerCase());

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+(.*)/);
    if (!match?.[1] || match[2] === undefined) continue;

    const title = match[2];
    if (!lowerHeadings.includes(title.toLowerCase())) continue;

    const level = match[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const nextMatch = lines[j]!.match(/^(#{1,6})\s/);
      if (nextMatch?.[1] && nextMatch[1].length <= level) {
        end = j;
        break;
      }
    }

    result.set(title, lines.slice(i, end).join("\n").trimEnd());
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export async function handleGetDocIndex(source: DocsSource): Promise<ToolResult> {
  const files = await source.listFiles("**/*.md");
  if (files.length === 0) {
    return textResult("No documentation files found.", true);
  }

  const entries: string[] = [];
  for (const file of files) {
    const content = await source.readFile(file);
    const lines = content.split("\n");

    const title = lines[0]?.replace(/^#\s+/, "") || "(No title)";

    let abstract = "";
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      if (line.startsWith("#")) break;
      abstract = line;
      break;
    }

    const entry = abstract ? `- ${file}: ${title} — ${abstract}` : `- ${file}: ${title}`;
    entries.push(entry);
  }

  return textResult(`## Documentation Index\n\n${entries.join("\n")}`);
}

export async function handleReadDocFile(args: { file_path?: string }, source: DocsSource): Promise<ToolResult> {
  if (!args.file_path) {
    return textResult("Invalid arguments: file_path is required.", true);
  }

  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("Invalid path or security violation.", true);
  }

  try {
    const content = await source.readFile(resolved);
    return textResult(content);
  } catch {
    return textResult(`File not found: ${args.file_path}`, true);
  }
}

export async function handleGetFileToc(args: { file_path: string; include_abstracts?: boolean }, source: DocsSource): Promise<ToolResult> {
  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("Invalid path.", true);
  }

  try {
    const content = await source.readFile(resolved);
    const toc = extractToc(content, args.include_abstracts ?? false);
    return textResult(
      `## Table of Contents for ${args.file_path}\n\n${toc.join("\n")}`
    );
  } catch {
    return textResult("File not found.", true);
  }
}

export async function handleGetChapters(args: { file_path: string; headings: string[] }, source: DocsSource): Promise<ToolResult> {
  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("Invalid path or security violation.", true);
  }

  try {
    const content = await source.readFile(resolved);
    const chapters = extractChapters(content, args.headings);

    if (chapters.size === 0) {
      const notFound = args.headings.join(", ");
      return textResult(`No matching chapters found for: ${notFound}`);
    }

    const sections: string[] = [];
    for (const [, body] of chapters) {
      sections.push(body);
    }

    return textResult(sections.join("\n\n---\n\n"));
  } catch {
    return textResult("File not found.", true);
  }
}

export async function handleSearchDocs(args: { query: string; path_pattern?: string }, source: DocsSource): Promise<ToolResult> {
  const { query, path_pattern } = args;

  let regex: RegExp;
  try {
    regex = new RegExp(query, "i");
  } catch {
    return textResult(`Invalid regex pattern: ${query}`, true);
  }

  let globPattern = "**/*.md";
  if (path_pattern) {
    if (path_pattern.endsWith(".md")) {
      globPattern = path_pattern;
    } else if (path_pattern.endsWith("/")) {
      globPattern = `${path_pattern}**/*.md`;
    } else if (path_pattern.includes("*")) {
      globPattern = path_pattern;
    } else {
      globPattern = `${path_pattern}/**/*.md`;
    }
  }

  const files = await source.listFiles(globPattern);
  const results: string[] = [];

  for (const file of files) {
    const content = await source.readFile(file);

    content.split("\n").forEach((line, i) => {
      if (regex.test(line)) {
        results.push(`[${file}:${i + 1}] ${line.trim()}`);
      }
    });
  }

  if (results.length === 0) {
    return textResult("No matches found.");
  }

  const MAX_RESULTS = 50;
  const limitedResults = results.slice(0, MAX_RESULTS);
  const overflow =
    results.length > MAX_RESULTS
      ? `\n... (${results.length - MAX_RESULTS} more matches hidden)`
      : "";

  return textResult(
    `## Search Results for "${query}"\n\n${limitedResults.join("\n")}${overflow}`
  );
}
