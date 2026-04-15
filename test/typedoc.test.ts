import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { TypeDocParser } from "../src/api/parsers/typedoc-parser.js";
import {
  ApiDocIndex,
  handleGetApiIndex,
  handleGetApiType,
  handleGetApiMember,
  handleSearchApi,
} from "../src/api/handlers.js";
import { FileSystemSource } from "../src/source.js";
import fs from "fs/promises";

const FIXTURES_PATH = path.resolve(import.meta.dirname, "fixtures-typedoc");
const fixturesSource = new FileSystemSource(FIXTURES_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// TypeDoc Parser Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TypeDocParser", () => {
  let jsonContent: string;
  const parser = new TypeDocParser();

  beforeAll(async () => {
    jsonContent = await fs.readFile(path.join(FIXTURES_PATH, "sample.json"), "utf-8");
  });

  it("parses namespaces from TypeDoc JSON", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const nsNames = namespaces.map(ns => ns.name);
    expect(nsNames).toContain("models");
    expect(nsNames).toContain("services");
  });

  it("parses class types", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const user = models.types.find(t => t.name === "User");
    expect(user).toBeDefined();
    expect(user!.kind).toBe("class");
    expect(user!.summary).toBe("Represents a user in the system.");
    expect(user!.remarks).toBe("Users are stored in the database.");
  });

  it("parses interface types", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const role = models.types.find(t => t.name === "Role");
    expect(role).toBeDefined();
    expect(role!.kind).toBe("interface");
    expect(role!.summary).toBe("Defines the shape of a user role.");
  });

  it("parses enum types with members", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const status = models.types.find(t => t.name === "Status");
    expect(status).toBeDefined();
    expect(status!.kind).toBe("enum");
    expect(status!.members.length).toBe(2);
    expect(status!.members[0]!.name).toBe("Active");
  });

  it("parses properties with types", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const user = models.types.find(t => t.name === "User")!;
    const idProp = user.members.find(m => m.name === "id");
    expect(idProp).toBeDefined();
    expect(idProp!.kind).toBe("property");
    expect(idProp!.signature).toBe("id: number");
    expect(idProp!.summary).toBe("The unique identifier.");
  });

  it("parses array types", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const role = models.types.find(t => t.name === "Role")!;
    const perms = role.members.find(m => m.name === "permissions");
    expect(perms!.signature).toBe("permissions: string[]");
  });

  it("parses methods with params and return types", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const user = models.types.find(t => t.name === "User")!;
    const method = user.members.find(m => m.name === "getDisplayName");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
    expect(method!.signature).toBe("getDisplayName(): string");
    expect(method!.returns).toBe("The display name string.");
  });

  it("parses constructors", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const user = models.types.find(t => t.name === "User")!;
    const ctor = user.members.find(m => m.kind === "constructor");
    expect(ctor).toBeDefined();
    expect(ctor!.params).toHaveLength(2);
    expect(ctor!.params![0]!.name).toBe("name");
    expect(ctor!.params![0]!.type).toBe("string");
  });

  it("parses examples from block tags", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const models = namespaces.find(ns => ns.name === "models")!;
    const user = models.types.find(t => t.name === "User")!;
    const method = user.members.find(m => m.name === "setPassword");
    expect(method!.examples).toHaveLength(1);
    expect(method!.examples![0]).toContain("setPassword");
  });

  it("parses standalone functions", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const services = namespaces.find(ns => ns.name === "services")!;
    const createUser = services.types.find(t => t.name === "createUser");
    expect(createUser).toBeDefined();
    expect(createUser!.kind).toBe("function");
    expect(createUser!.summary).toBe("Creates a new user in the system.");
    // Function has its signature as a member
    expect(createUser!.members.length).toBeGreaterThan(0);
    expect(createUser!.members[0]!.signature).toContain("createUser(");
    expect(createUser!.members[0]!.signature).toContain("Promise<User>");
  });

  it("parses type aliases", () => {
    const namespaces = parser.parse(jsonContent, "sample.json");
    const services = namespaces.find(ns => ns.name === "services")!;
    const callback = services.types.find(t => t.name === "UserCallback");
    expect(callback).toBeDefined();
    expect(callback!.kind).toBe("type-alias");
  });

  it("returns empty for non-JSON content", () => {
    const result = parser.parse("not json", "bad.json");
    expect(result).toEqual([]);
  });

  it("returns empty for JSON that is not TypeDoc format", () => {
    const result = parser.parse('{"foo": "bar"}', "other.json");
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Handler Tests (TypeDoc)
// ─────────────────────────────────────────────────────────────────────────────

describe("API Handlers (TypeDoc)", () => {
  let apiIndex: ApiDocIndex;

  beforeAll(() => {
    apiIndex = new ApiDocIndex(fixturesSource, [new TypeDocParser()]);
  });

  describe("handleGetApiIndex", () => {
    it("returns namespaces and types", async () => {
      const result = await handleGetApiIndex(undefined, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("api_index:");
      expect(result.content[0]!.text).toContain("models");
      expect(result.content[0]!.text).toContain("services");
      expect(result.content[0]!.text).toContain("User");
      expect(result.content[0]!.text).toContain("Role");
    });
  });

  describe("handleGetApiType", () => {
    it("returns type details", async () => {
      const result = await handleGetApiType({ type_name: "User" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("api_type:");
      expect(result.content[0]!.text).toContain("Represents a user");
      expect(result.content[0]!.text).toContain("id");
      expect(result.content[0]!.text).toContain("getDisplayName");
    });

    it("returns error for unknown type", async () => {
      const result = await handleGetApiType({ type_name: "NonExistent" }, apiIndex);
      expect(result.isError).toBe(true);
    });
  });

  describe("handleGetApiMember", () => {
    it("returns member details", async () => {
      const result = await handleGetApiMember(
        { type_name: "User", member_name: "setPassword" },
        apiIndex
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("setPassword");
      expect(result.content[0]!.text).toContain("password");
    });
  });

  describe("handleSearchApi", () => {
    it("finds types and members", async () => {
      const result = await handleSearchApi({ query: "user" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("User");
    });

    it("finds by summary text", async () => {
      const result = await handleSearchApi({ query: "password" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("setPassword");
    });
  });
});
