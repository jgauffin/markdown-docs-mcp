import type { ApiDocParser, ApiNamespace, ApiType, ApiMember, ApiParam } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// TypeDoc ReflectionKind values
// ─────────────────────────────────────────────────────────────────────────────

const Kind = {
  Project: 1,
  Module: 2,
  Namespace: 4,
  Enum: 8,
  EnumMember: 16,
  Variable: 32,
  Function: 64,
  Class: 128,
  Interface: 256,
  Constructor: 512,
  Property: 1024,
  Method: 2048,
  Accessor: 262144,
  TypeAlias: 2097152,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TypeDoc JSON types (minimal subset we need)
// ─────────────────────────────────────────────────────────────────────────────

interface TdReflection {
  id?: number;
  name?: string;
  kind?: number;
  comment?: TdComment;
  children?: TdReflection[];
  signatures?: TdSignature[];
  type?: TdType;
  defaultValue?: string;
}

interface TdSignature {
  name?: string;
  kind?: number;
  comment?: TdComment;
  parameters?: TdParameter[];
  type?: TdType;
}

interface TdParameter {
  name?: string;
  comment?: TdComment;
  type?: TdType;
}

interface TdComment {
  summary?: TdDisplayPart[];
  blockTags?: TdBlockTag[];
}

interface TdBlockTag {
  tag: string;
  content?: TdDisplayPart[];
}

interface TdDisplayPart {
  kind: string;
  text: string;
}

interface TdType {
  type: string;
  name?: string;
  value?: unknown;
  types?: TdType[];
  elementType?: TdType;
  typeArguments?: TdType[];
  declaration?: TdReflection;
  target?: unknown;
  package?: string;
  qualifiedName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractCommentText(comment?: TdComment): string | undefined {
  if (!comment?.summary) return undefined;
  const text = comment.summary.map(p => p.text).join("").trim();
  return text || undefined;
}

function extractBlockTag(comment?: TdComment, tag?: string): string | undefined {
  if (!comment?.blockTags) return undefined;
  const block = comment.blockTags.find(b => b.tag === tag);
  if (!block?.content) return undefined;
  return block.content.map(p => p.text).join("").trim() || undefined;
}

function extractExamples(comment?: TdComment): string[] | undefined {
  if (!comment?.blockTags) return undefined;
  const examples = comment.blockTags
    .filter(b => b.tag === "@example")
    .map(b => b.content?.map(p => p.text).join("").trim() ?? "")
    .filter(Boolean);
  return examples.length > 0 ? examples : undefined;
}

function typeToString(type?: TdType): string {
  if (!type) return "unknown";

  switch (type.type) {
    case "intrinsic":
    case "reference":
      return formatWithTypeArgs(type.name ?? "unknown", type.typeArguments);
    case "literal":
      return JSON.stringify(type.value);
    case "union":
      return (type.types ?? []).map(typeToString).join(" | ");
    case "intersection":
      return (type.types ?? []).map(typeToString).join(" & ");
    case "array":
      return `${typeToString(type.elementType)}[]`;
    case "tuple":
      return `[${(type.types ?? []).map(typeToString).join(", ")}]`;
    case "reflection":
      return "object";
    default:
      return type.name ?? "unknown";
  }
}

function formatWithTypeArgs(name: string, typeArgs?: TdType[]): string {
  if (!typeArgs || typeArgs.length === 0) return name;
  return `${name}<${typeArgs.map(typeToString).join(", ")}>`;
}

function buildSignature(name: string, sig: TdSignature): string {
  const params = (sig.parameters ?? [])
    .map(p => `${p.name ?? "?"}: ${typeToString(p.type)}`)
    .join(", ");
  const ret = typeToString(sig.type);
  return `${name}(${params}): ${ret}`;
}

function kindToTypeKind(kind: number): ApiType["kind"] | null {
  switch (kind) {
    case Kind.Class: return "class";
    case Kind.Interface: return "interface";
    case Kind.Enum: return "enum";
    case Kind.Function: return "function";
    case Kind.TypeAlias: return "type-alias";
    default: return null;
  }
}

function kindToMemberKind(kind: number): ApiMember["kind"] | null {
  switch (kind) {
    case Kind.Method: return "method";
    case Kind.Property: return "property";
    case Kind.Variable: return "property";
    case Kind.Constructor: return "constructor";
    case Kind.Accessor: return "accessor";
    case Kind.EnumMember: return "field";
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

export class TypeDocParser implements ApiDocParser {
  filePattern = "**/*.json";

  parse(content: string, _filePath: string): ApiNamespace[] {
    let root: TdReflection;
    try {
      root = JSON.parse(content);
    } catch {
      return [];
    }

    // Must look like a TypeDoc project (kind=1 with children)
    if (!root || root.kind !== Kind.Project || !root.children) return [];

    const pkg = typeof root.name === "string" ? root.name : undefined;
    const nsMap = new Map<string, ApiType[]>();

    const processChildren = (children: TdReflection[], nsPrefix: string) => {
      for (const child of children) {
        const kind = child.kind ?? 0;

        // Module/Namespace → recurse with extended prefix
        if (kind === Kind.Module || kind === Kind.Namespace) {
          const childNs = nsPrefix ? `${nsPrefix}.${child.name ?? ""}` : (child.name ?? "");
          if (child.children) {
            processChildren(child.children, childNs);
          }
          continue;
        }

        // Type-level items
        const typeKind = kindToTypeKind(kind);
        if (!typeKind) continue;

        const typeName = child.name ?? "(anonymous)";
        const fullName = nsPrefix ? `${nsPrefix}.${typeName}` : typeName;

        // For functions, use signature comment if the function itself has none
        const funcSig = (kind === Kind.Function) ? child.signatures?.[0] : undefined;
        const comment = child.comment ?? funcSig?.comment;

        const apiType: ApiType = {
          name: typeName,
          fullName,
          kind: typeKind,
          package: pkg,
          summary: extractCommentText(comment),
          remarks: extractBlockTag(comment, "@remarks"),
          members: [],
        };

        // Function: treat as a type with no explicit members, but add signature info
        if (kind === Kind.Function && child.signatures) {
          for (const sig of child.signatures) {
            const member: ApiMember = {
              name: typeName,
              kind: "method",
              signature: buildSignature(typeName, sig),
              summary: extractCommentText(sig.comment),
              returns: extractBlockTag(sig.comment, "@returns") ?? typeToString(sig.type),
            };

            const params = extractParams(sig);
            if (params) member.params = params;

            const examples = extractExamples(sig.comment);
            if (examples) member.examples = examples;

            apiType.members.push(member);
          }
        }

        // Class/Interface/Enum: process children as members
        if (child.children) {
          for (const memberChild of child.children) {
            const memberKind = kindToMemberKind(memberChild.kind ?? 0);
            if (!memberKind) continue;

            const memberName = memberChild.name ?? "(anonymous)";
            const sig = memberChild.signatures?.[0];
            const memberComment = memberChild.comment ?? sig?.comment;

            const member: ApiMember = {
              name: memberName,
              kind: memberKind,
              summary: extractCommentText(memberComment),
            };

            if (sig) {
              member.signature = buildSignature(memberName, sig);
              member.returns = extractBlockTag(sig.comment, "@returns") ?? typeToString(sig.type);
              const params = extractParams(sig);
              if (params) member.params = params;
              const examples = extractExamples(sig.comment);
              if (examples) member.examples = examples;
            } else if (memberChild.type) {
              member.signature = `${memberName}: ${typeToString(memberChild.type)}`;
            }

            apiType.members.push(member);
          }
        }

        const ns = nsPrefix || "(global)";
        if (!nsMap.has(ns)) nsMap.set(ns, []);
        nsMap.get(ns)!.push(apiType);
      }
    };

    // Project root name is not a namespace — modules/namespaces under it are
    processChildren(root.children, "");

    const namespaces: ApiNamespace[] = [];
    for (const [name, types] of nsMap) {
      types.sort((a, b) => a.name.localeCompare(b.name));
      namespaces.push({ name, types });
    }
    namespaces.sort((a, b) => a.name.localeCompare(b.name));

    return namespaces;
  }
}

function extractParams(sig: TdSignature): ApiParam[] | undefined {
  if (!sig.parameters || sig.parameters.length === 0) return undefined;
  const params: ApiParam[] = sig.parameters.map(p => ({
    name: p.name ?? "?",
    type: typeToString(p.type),
    description: extractCommentText(p.comment) ?? "",
  }));
  return params;
}
