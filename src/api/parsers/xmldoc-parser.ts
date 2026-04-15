import { XMLParser } from "fast-xml-parser";
import type { ApiDocParser, ApiNamespace, ApiType, ApiMember, ApiParam } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// XmlDoc member name parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedMemberName {
  prefix: string;        // T, M, P, F, E
  namespace: string;     // e.g. "MyLib.Models"
  typeName: string;      // e.g. "User"
  memberName?: string;   // e.g. "GetName" (undefined for types)
  params?: string;       // e.g. "(System.String,System.Int32)"
}

function parseMemberName(raw: string): ParsedMemberName | null {
  if (raw.length < 3 || raw[1] !== ":") return null;

  const prefix = raw[0]!;
  let rest = raw.slice(2);

  // Extract params for methods
  let params: string | undefined;
  const parenIdx = rest.indexOf("(");
  if (parenIdx !== -1) {
    params = rest.slice(parenIdx);
    rest = rest.slice(0, parenIdx);
  }

  const parts = rest.split(".");

  if (prefix === "T") {
    // Type: everything before last dot is namespace, last is type name
    const typeName = parts.pop()!;
    const namespace = parts.join(".") || "(global)";
    return { prefix, namespace, typeName };
  }

  // Member: second-to-last is type, last is member, rest is namespace
  if (parts.length < 2) return null;
  const memberName = parts.pop()!;
  const typeName = parts.pop()!;
  const namespace = parts.join(".") || "(global)";
  return { prefix, namespace, typeName, memberName, params };
}

function prefixToMemberKind(prefix: string, memberName?: string): ApiMember["kind"] {
  if (memberName === "#ctor") return "constructor";
  switch (prefix) {
    case "M": return "method";
    case "P": return "property";
    case "F": return "field";
    case "E": return "event";
    default: return "method";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// XML text extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract text content from a parsed XML node (may be string, object with #text, or mixed content). */
function extractText(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node.trim();
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(extractText).filter(Boolean).join(" ");
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // fast-xml-parser puts text content in #text
    if ("#text" in obj) return extractText(obj["#text"]);
    // Collect all text values from child elements
    const texts: string[] = [];
    for (const val of Object.values(obj)) {
      const t = extractText(val);
      if (t) texts.push(t);
    }
    return texts.join(" ");
  }
  return "";
}

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

interface XmlMember {
  "@_name": string;
  summary?: unknown;
  remarks?: unknown;
  param?: unknown | unknown[];
  returns?: unknown;
  exception?: unknown | unknown[];
  example?: unknown | unknown[];
}

export class XmlDocParser implements ApiDocParser {
  filePattern = "**/*.xml";

  parse(content: string, _filePath: string): ApiNamespace[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      isArray: (name) => name === "member" || name === "param" || name === "exception" || name === "example",
    });

    let parsed: unknown;
    try {
      parsed = parser.parse(content);
    } catch {
      return []; // not valid XML
    }

    const doc = (parsed as Record<string, unknown>)?.doc as Record<string, unknown> | undefined;
    if (!doc) return [];

    const assemblyNode = doc.assembly as Record<string, unknown> | undefined;
    const pkg = typeof assemblyNode?.name === "string" ? (assemblyNode.name as string) : undefined;

    const membersContainer = doc.members as Record<string, unknown> | undefined;
    if (!membersContainer) return [];

    const members = asArray(membersContainer.member as XmlMember | XmlMember[]);

    // Group by namespace+type
    const typeMap = new Map<string, { type: ApiType; nsName: string }>();

    for (const member of members) {
      const name = member["@_name"];
      if (!name) continue;

      const parsed = parseMemberName(name);
      if (!parsed) continue;

      const typeKey = `${parsed.namespace}.${parsed.typeName}`;

      if (parsed.prefix === "T") {
        // Type definition
        if (!typeMap.has(typeKey)) {
          typeMap.set(typeKey, {
            nsName: parsed.namespace,
            type: {
              name: parsed.typeName,
              fullName: typeKey,
              kind: "class", // XmlDoc doesn't distinguish in the XML; default to class
              package: pkg,
              summary: extractText(member.summary) || undefined,
              remarks: extractText(member.remarks) || undefined,
              members: [],
            },
          });
        } else {
          // Update summary/remarks if type was created by a member first
          const existing = typeMap.get(typeKey)!;
          if (!existing.type.summary) existing.type.summary = extractText(member.summary) || undefined;
          if (!existing.type.remarks) existing.type.remarks = extractText(member.remarks) || undefined;
        }
        continue;
      }

      // Member definition — ensure parent type exists
      if (!typeMap.has(typeKey)) {
        typeMap.set(typeKey, {
          nsName: parsed.namespace,
          type: {
            name: parsed.typeName,
            fullName: typeKey,
            kind: "class",
            package: pkg,
            members: [],
          },
        });
      }

      const displayName = parsed.memberName === "#ctor" ? "constructor" : (parsed.memberName ?? name);
      const signature = parsed.params
        ? `${displayName}${parsed.params}`
        : displayName;

      const apiMember: ApiMember = {
        name: displayName,
        kind: prefixToMemberKind(parsed.prefix, parsed.memberName),
        signature,
        summary: extractText(member.summary) || undefined,
        returns: extractText(member.returns) || undefined,
      };

      // Params
      const params = asArray(member.param);
      if (params.length > 0) {
        apiMember.params = params.map((p): ApiParam => {
          const pObj = p as Record<string, unknown>;
          return {
            name: String(pObj["@_name"] ?? ""),
            description: extractText(pObj),
          };
        });
      }

      // Exceptions
      const exceptions = asArray(member.exception);
      if (exceptions.length > 0) {
        apiMember.exceptions = exceptions.map((e) => {
          const eObj = e as Record<string, unknown>;
          return {
            type: String(eObj["@_cref"] ?? ""),
            description: extractText(eObj),
          };
        });
      }

      // Examples
      const examples = asArray(member.example);
      if (examples.length > 0) {
        apiMember.examples = examples.map((e) => extractText(e)).filter(Boolean);
      }

      typeMap.get(typeKey)!.type.members.push(apiMember);
    }

    // Group types by namespace
    const nsMap = new Map<string, ApiType[]>();
    for (const { nsName, type } of typeMap.values()) {
      if (!nsMap.has(nsName)) nsMap.set(nsName, []);
      nsMap.get(nsName)!.push(type);
    }

    const namespaces: ApiNamespace[] = [];
    for (const [name, types] of nsMap) {
      types.sort((a, b) => a.name.localeCompare(b.name));
      namespaces.push({ name, types });
    }
    namespaces.sort((a, b) => a.name.localeCompare(b.name));

    return namespaces;
  }
}
