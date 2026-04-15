import type { DocsSource } from "../source.js";
import type { ApiDocParser, ApiNamespace, ApiType, ApiMember } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// YAML Helpers (consistent with markdown handlers)
// ─────────────────────────────────────────────────────────────────────────────

function yStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function yBlock(content: string, indent: number): string {
  const pad = ' '.repeat(indent);
  return '|\n' + content.split('\n').map(l => l ? pad + l : '').join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Security helpers
// ─────────────────────────────────────────────────────────────────────────────

function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool result type (same as markdown handlers)
// ─────────────────────────────────────────────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

// ─────────────────────────────────────────────────────────────────────────────
// ApiDocIndex — cached index of all parsed API docs
// ─────────────────────────────────────────────────────────────────────────────

export class ApiDocIndex {
  private namespaces: ApiNamespace[] | null = null;

  constructor(
    private source: DocsSource,
    private parsers: ApiDocParser[]
  ) {}

  async getNamespaces(): Promise<ApiNamespace[]> {
    if (this.namespaces) return this.namespaces;

    console.error(`[api-index] Building API index...`);
    const allNs: ApiNamespace[] = [];
    for (const parser of this.parsers) {
      const files = await this.source.listFiles(parser.filePattern);
      console.error(`[api-index] Parser ${parser.filePattern}: ${files.length} files`);
      for (const file of files) {
        try {
          const content = await this.source.readFile(file);
          const parsed = parser.parse(content, file);
          allNs.push(...parsed);
          console.error(`[api-index] Parsed ${file}: ${parsed.length} namespaces`);
        } catch (err) {
          console.error(`[api-index] Failed to parse ${file}: ${err}`);
        }
      }
    }

    this.namespaces = mergeNamespaces(allNs);
    console.error(`[api-index] Index built: ${this.namespaces.length} namespaces, ${this.namespaces.reduce((s, n) => s + n.types.length, 0)} types`);
    return this.namespaces;
  }

  findType(typeName: string, pkg?: string): { ns: ApiNamespace; type: ApiType } | null {
    if (!this.namespaces) return null;
    const lower = typeName.toLowerCase();
    const pkgLower = pkg?.toLowerCase();
    const pkgMatch = (t: ApiType) => !pkgLower || t.package?.toLowerCase() === pkgLower;

    for (const ns of this.namespaces) {
      for (const type of ns.types) {
        if (pkgMatch(type) && type.fullName.toLowerCase() === lower) return { ns, type };
      }
    }
    for (const ns of this.namespaces) {
      for (const type of ns.types) {
        if (pkgMatch(type) && type.name.toLowerCase() === lower) return { ns, type };
      }
    }
    for (const ns of this.namespaces) {
      for (const type of ns.types) {
        if (pkgMatch(type) && type.fullName.toLowerCase().includes(lower)) return { ns, type };
      }
    }
    return null;
  }

  listPackages(): string[] {
    if (!this.namespaces) return [];
    const set = new Set<string>();
    for (const ns of this.namespaces) {
      for (const type of ns.types) {
        if (type.package) set.add(type.package);
      }
    }
    return [...set].sort();
  }
}

function mergeNamespaces(namespaces: ApiNamespace[]): ApiNamespace[] {
  const nsMap = new Map<string, ApiType[]>();
  for (const ns of namespaces) {
    if (!nsMap.has(ns.name)) nsMap.set(ns.name, []);
    nsMap.get(ns.name)!.push(...ns.types);
  }

  const result: ApiNamespace[] = [];
  for (const [name, types] of nsMap) {
    types.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ name, types });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_THRESHOLD = 100;

function formatMemberSummary(m: ApiMember, indent: number): string {
  const pad = ' '.repeat(indent);
  let yaml = `${pad}- name: ${yStr(m.name)}\n`;
  yaml += `${pad}  kind: ${m.kind}`;
  if (m.signature) yaml += `\n${pad}  signature: ${yStr(m.signature)}`;
  if (m.summary) yaml += `\n${pad}  summary: ${yStr(m.summary)}`;
  return yaml;
}

function formatMemberFull(m: ApiMember, indent: number): string {
  const pad = ' '.repeat(indent);
  let yaml = `${pad}- name: ${yStr(m.name)}\n`;
  yaml += `${pad}  kind: ${m.kind}`;
  if (m.signature) yaml += `\n${pad}  signature: ${yStr(m.signature)}`;
  if (m.summary) yaml += `\n${pad}  summary: ${yStr(m.summary)}`;

  if (m.params && m.params.length > 0) {
    yaml += `\n${pad}  params:`;
    for (const p of m.params) {
      yaml += `\n${pad}   - name: ${yStr(p.name)}`;
      if (p.type) yaml += `\n${pad}     type: ${yStr(p.type)}`;
      yaml += `\n${pad}     description: ${yStr(p.description)}`;
    }
  }

  if (m.returns) yaml += `\n${pad}  returns: ${yStr(m.returns)}`;

  if (m.exceptions && m.exceptions.length > 0) {
    yaml += `\n${pad}  exceptions:`;
    for (const e of m.exceptions) {
      yaml += `\n${pad}   - type: ${yStr(e.type)}`;
      yaml += `\n${pad}     description: ${yStr(e.description)}`;
    }
  }

  if (m.examples && m.examples.length > 0) {
    yaml += `\n${pad}  examples:`;
    for (const ex of m.examples) {
      yaml += `\n${pad}   - ${yBlock(ex, indent + 5)}`;
    }
  }

  return yaml;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────────────────────

export async function handleGetApiIndex(
  args: { package?: string } | undefined,
  index: ApiDocIndex,
): Promise<ToolResult> {
  const pkgFilter = args?.package?.toLowerCase();

  const allNs = await index.getNamespaces();

  // Filter namespaces/types to the requested package if given.
  const namespaces = pkgFilter
    ? allNs
        .map((ns) => ({
          name: ns.name,
          types: ns.types.filter((t) => t.package?.toLowerCase() === pkgFilter),
        }))
        .filter((ns) => ns.types.length > 0)
    : allNs;

  if (namespaces.length === 0) {
    if (pkgFilter) {
      const packages = index.listPackages();
      return textResult(
        `error: No types found for package "${args?.package}". Available packages: ${packages.join(", ") || "(none)"}`,
        true,
      );
    }
    return textResult("error: No API documentation found.", true);
  }

  const totalTypes = namespaces.reduce((sum, ns) => sum + ns.types.length, 0);
  const packages = index.listPackages();

  let yaml = 'api_index:\n';
  yaml += ` total_namespaces: ${namespaces.length}\n`;
  yaml += ` total_types: ${totalTypes}\n`;
  if (packages.length > 0) {
    yaml += ` packages:\n`;
    for (const p of packages) yaml += `  - ${yStr(p)}\n`;
  }
  yaml += ' namespaces:\n';

  for (const ns of namespaces) {
    yaml += `  - name: ${yStr(ns.name)}\n`;
    yaml += `    types:\n`;

    if (totalTypes <= INDEX_THRESHOLD) {
      for (const type of ns.types) {
        yaml += `     - name: ${yStr(type.name)}\n`;
        yaml += `       fullName: ${yStr(type.fullName)}\n`;
        yaml += `       kind: ${type.kind}`;
        if (type.package) yaml += `\n       package: ${yStr(type.package)}`;
        if (type.summary) yaml += `\n       summary: ${yStr(type.summary)}`;
        yaml += `\n       members: ${type.members.length}`;
        yaml += '\n';
      }
    } else {
      for (const type of ns.types) {
        yaml += `     - name: ${yStr(type.name)}\n`;
        yaml += `       kind: ${type.kind}\n`;
        if (type.package) yaml += `       package: ${yStr(type.package)}\n`;
        yaml += `       members: ${type.members.length}\n`;
      }
    }
  }

  return textResult(yaml.trimEnd());
}

export async function handleGetApiType(
  args: { type_name?: string; package?: string },
  index: ApiDocIndex
): Promise<ToolResult> {
  if (!args.type_name) {
    return textResult("error: type_name is required.", true);
  }

  await index.getNamespaces();

  const found = index.findType(args.type_name, args.package);
  if (!found) {
    const suffix = args.package ? ` in package "${args.package}"` : "";
    return textResult(`error: Type not found: ${args.type_name}${suffix}`, true);
  }

  const { ns, type } = found;

  let yaml = 'api_type:\n';
  yaml += ` namespace: ${yStr(ns.name)}\n`;
  yaml += ` name: ${yStr(type.name)}\n`;
  yaml += ` fullName: ${yStr(type.fullName)}\n`;
  yaml += ` kind: ${type.kind}\n`;
  if (type.package) yaml += ` package: ${yStr(type.package)}\n`;
  if (type.summary) yaml += ` summary: ${yStr(type.summary)}\n`;
  if (type.remarks) yaml += ` remarks: ${yStr(type.remarks)}\n`;
  yaml += ` members:\n`;

  for (const m of type.members) {
    yaml += formatMemberSummary(m, 2) + '\n';
  }

  return textResult(yaml.trimEnd());
}

export async function handleGetApiMember(
  args: { type_name?: string; member_name?: string; package?: string },
  index: ApiDocIndex
): Promise<ToolResult> {
  if (!args.type_name) {
    return textResult("error: type_name is required.", true);
  }
  if (!args.member_name) {
    return textResult("error: member_name is required.", true);
  }

  await index.getNamespaces();

  const found = index.findType(args.type_name, args.package);
  if (!found) {
    const suffix = args.package ? ` in package "${args.package}"` : "";
    return textResult(`error: Type not found: ${args.type_name}${suffix}`, true);
  }

  const lowerMember = args.member_name.toLowerCase();
  const members = found.type.members.filter(
    m => m.name.toLowerCase() === lowerMember ||
         (m.signature && m.signature.toLowerCase().includes(lowerMember))
  );

  if (members.length === 0) {
    return textResult(`error: Member not found: ${args.member_name} in ${found.type.fullName}`, true);
  }

  let yaml = 'api_member:\n';
  yaml += ` type: ${yStr(found.type.fullName)}\n`;
  yaml += ' members:\n';

  for (const m of members) {
    yaml += formatMemberFull(m, 2) + '\n';
  }

  return textResult(yaml.trimEnd());
}

export async function handleSearchApi(
  args: { query?: string; package?: string },
  index: ApiDocIndex
): Promise<ToolResult> {
  if (!args.query) {
    return textResult("error: query is required.", true);
  }

  if (!isSafeRegex(args.query)) {
    return textResult("error: Potentially unsafe regex pattern rejected.", true);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(args.query, "i");
  } catch {
    return textResult(`error: Invalid regex pattern: ${args.query}`, true);
  }

  const namespaces = await index.getNamespaces();
  const pkgFilter = args.package?.toLowerCase();
  const MAX_RESULTS = 50;
  const results: { type: string; package?: string; member?: string; kind: string; summary?: string }[] = [];

  for (const ns of namespaces) {
    for (const type of ns.types) {
      if (pkgFilter && type.package?.toLowerCase() !== pkgFilter) continue;

      if (regex.test(type.name) || regex.test(type.fullName) || (type.summary && regex.test(type.summary))) {
        results.push({
          type: type.fullName,
          package: type.package,
          kind: type.kind,
          summary: type.summary,
        });
        if (results.length >= MAX_RESULTS) break;
      }

      for (const m of type.members) {
        if (results.length >= MAX_RESULTS) break;
        if (
          regex.test(m.name) ||
          (m.signature && regex.test(m.signature)) ||
          (m.summary && regex.test(m.summary))
        ) {
          results.push({
            type: type.fullName,
            package: type.package,
            member: m.name,
            kind: m.kind,
            summary: m.summary,
          });
        }
      }
      if (results.length >= MAX_RESULTS) break;
    }
    if (results.length >= MAX_RESULTS) break;
  }

  if (results.length === 0) {
    return textResult("No matches found.");
  }

  let yaml = 'api_search:\n';
  yaml += ` query: ${yStr(args.query)}\n`;
  if (args.package) yaml += ` package: ${yStr(args.package)}\n`;
  yaml += ` total: ${results.length}\n`;
  yaml += ' results:\n';

  for (const r of results) {
    yaml += `  - type: ${yStr(r.type)}\n`;
    if (r.package) yaml += `    package: ${yStr(r.package)}\n`;
    if (r.member) yaml += `    member: ${yStr(r.member)}\n`;
    yaml += `    kind: ${r.kind}`;
    if (r.summary) yaml += `\n    summary: ${yStr(r.summary)}`;
    yaml += '\n';
  }

  return textResult(yaml.trimEnd());
}
