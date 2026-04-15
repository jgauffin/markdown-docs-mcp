// ─────────────────────────────────────────────────────────────────────────────
// Shared API Documentation Model
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiDocParser {
  /** Glob pattern(s) to find doc files. */
  filePattern: string | string[];

  /** Parse a single file's content into namespaces/types. */
  parse(content: string, filePath: string): ApiNamespace[];
}

export interface ApiNamespace {
  name: string;
  types: ApiType[];
}

export interface ApiType {
  name: string;
  fullName: string;
  kind: "class" | "interface" | "struct" | "enum" | "delegate" | "function" | "type-alias";
  /** Package this type belongs to — language-agnostic (C# assembly, npm package, crate, etc). */
  package?: string;
  summary?: string;
  remarks?: string;
  members: ApiMember[];
}

export interface ApiMember {
  name: string;
  kind: "method" | "property" | "field" | "event" | "constructor" | "accessor";
  signature?: string;
  summary?: string;
  params?: ApiParam[];
  returns?: string;
  exceptions?: { type: string; description: string }[];
  examples?: string[];
}

export interface ApiParam {
  name: string;
  type?: string;
  description: string;
}
