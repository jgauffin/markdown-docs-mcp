import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { XmlDocParser } from "../src/api/parsers/xmldoc-parser.js";
import {
  ApiDocIndex,
  handleGetApiIndex,
  handleGetApiType,
  handleGetApiMember,
  handleSearchApi,
} from "../src/api/handlers.js";
import { FileSystemSource } from "../src/source.js";
import fs from "fs/promises";

const FIXTURES_PATH = path.resolve(import.meta.dirname, "fixtures-xmldoc");
const fixturesSource = new FileSystemSource(FIXTURES_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// XmlDoc Parser Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("XmlDocParser", () => {
  let xmlContent: string;
  const parser = new XmlDocParser();

  beforeAll(async () => {
    xmlContent = await fs.readFile(path.join(FIXTURES_PATH, "TestLib.xml"), "utf-8");
  });

  it("parses namespaces from XML doc", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const nsNames = namespaces.map(ns => ns.name);
    expect(nsNames).toContain("TestLib.Models");
    expect(nsNames).toContain("TestLib.Services");
  });

  it("parses types within namespaces", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const models = namespaces.find(ns => ns.name === "TestLib.Models")!;
    const typeNames = models.types.map(t => t.name);
    expect(typeNames).toContain("User");
    expect(typeNames).toContain("Role");
  });

  it("parses type summary and remarks", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const models = namespaces.find(ns => ns.name === "TestLib.Models")!;
    const user = models.types.find(t => t.name === "User")!;
    expect(user.summary).toBe("Represents a user in the system.");
    expect(user.remarks).toBe("Users are identified by their unique Id property.");
    expect(user.fullName).toBe("TestLib.Models.User");
  });

  it("parses properties", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const models = namespaces.find(ns => ns.name === "TestLib.Models")!;
    const user = models.types.find(t => t.name === "User")!;
    const idProp = user.members.find(m => m.name === "Id");
    expect(idProp).toBeDefined();
    expect(idProp!.kind).toBe("property");
    expect(idProp!.summary).toBe("Gets or sets the unique identifier.");
  });

  it("parses methods with params and returns", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const services = namespaces.find(ns => ns.name === "TestLib.Services")!;
    const svc = services.types.find(t => t.name === "UserService")!;
    const getById = svc.members.find(m => m.name === "GetById");
    expect(getById).toBeDefined();
    expect(getById!.kind).toBe("method");
    expect(getById!.params).toHaveLength(1);
    expect(getById!.params![0]!.name).toBe("id");
    expect(getById!.returns).toBe("The user if found, null otherwise.");
  });

  it("parses exceptions", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const models = namespaces.find(ns => ns.name === "TestLib.Models")!;
    const user = models.types.find(t => t.name === "User")!;
    const setPwd = user.members.find(m => m.name === "SetPassword");
    expect(setPwd!.exceptions).toHaveLength(1);
    expect(setPwd!.exceptions![0]!.type).toBe("T:System.ArgumentException");
  });

  it("parses constructors", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const models = namespaces.find(ns => ns.name === "TestLib.Models")!;
    const user = models.types.find(t => t.name === "User")!;
    const ctor = user.members.find(m => m.kind === "constructor");
    expect(ctor).toBeDefined();
    expect(ctor!.name).toBe("constructor");
    expect(ctor!.params).toHaveLength(2);
  });

  it("parses fields", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const models = namespaces.find(ns => ns.name === "TestLib.Models")!;
    const role = models.types.find(t => t.name === "Role")!;
    const field = role.members.find(m => m.kind === "field");
    expect(field).toBeDefined();
    expect(field!.name).toBe("AdminRole");
  });

  it("parses events", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const services = namespaces.find(ns => ns.name === "TestLib.Services")!;
    const svc = services.types.find(t => t.name === "UserService")!;
    const evt = svc.members.find(m => m.kind === "event");
    expect(evt).toBeDefined();
    expect(evt!.name).toBe("UserCreated");
  });

  it("parses examples", () => {
    const namespaces = parser.parse(xmlContent, "TestLib.xml");
    const services = namespaces.find(ns => ns.name === "TestLib.Services")!;
    const svc = services.types.find(t => t.name === "UserService")!;
    const search = svc.members.find(m => m.name === "Search");
    expect(search!.examples).toHaveLength(1);
    expect(search!.examples![0]).toContain("Search");
  });

  it("returns empty for non-XML content", () => {
    const result = parser.parse("not xml at all", "bad.xml");
    expect(result).toEqual([]);
  });

  it("returns empty for XML without <doc> root", () => {
    const result = parser.parse("<root><child/></root>", "other.xml");
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Handler Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("API Handlers (XmlDoc)", () => {
  let apiIndex: ApiDocIndex;

  beforeAll(() => {
    apiIndex = new ApiDocIndex(fixturesSource, [new XmlDocParser()]);
  });

  describe("handleGetApiIndex", () => {
    it("returns namespaces and types", async () => {
      const result = await handleGetApiIndex(undefined, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("api_index:");
      expect(result.content[0]!.text).toContain("TestLib.Models");
      expect(result.content[0]!.text).toContain("TestLib.Services");
      expect(result.content[0]!.text).toContain("User");
      expect(result.content[0]!.text).toContain("Role");
      expect(result.content[0]!.text).toContain("UserService");
    });
  });

  describe("handleGetApiType", () => {
    it("returns type details by full name", async () => {
      const result = await handleGetApiType({ type_name: "TestLib.Models.User" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("api_type:");
      expect(result.content[0]!.text).toContain("Represents a user");
      expect(result.content[0]!.text).toContain("Id");
      expect(result.content[0]!.text).toContain("Name");
      expect(result.content[0]!.text).toContain("SetPassword");
    });

    it("returns type details by short name", async () => {
      const result = await handleGetApiType({ type_name: "UserService" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("UserService");
      expect(result.content[0]!.text).toContain("GetById");
    });

    it("returns type details by partial match", async () => {
      const result = await handleGetApiType({ type_name: "role" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("Role");
    });

    it("returns error for unknown type", async () => {
      const result = await handleGetApiType({ type_name: "NonExistent" }, apiIndex);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Type not found");
    });

    it("returns error when type_name is missing", async () => {
      const result = await handleGetApiType({} as { type_name: string }, apiIndex);
      expect(result.isError).toBe(true);
    });
  });

  describe("handleGetApiMember", () => {
    it("returns member details", async () => {
      const result = await handleGetApiMember(
        { type_name: "UserService", member_name: "GetById" },
        apiIndex
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("api_member:");
      expect(result.content[0]!.text).toContain("GetById");
      expect(result.content[0]!.text).toContain("id");
      expect(result.content[0]!.text).toContain("user identifier");
    });

    it("returns error for unknown member", async () => {
      const result = await handleGetApiMember(
        { type_name: "User", member_name: "NonExistent" },
        apiIndex
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Member not found");
    });

    it("returns error when member_name is missing", async () => {
      const result = await handleGetApiMember(
        { type_name: "User" } as { type_name: string; member_name: string },
        apiIndex
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("handleSearchApi", () => {
    it("finds types by name", async () => {
      const result = await handleSearchApi({ query: "User" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("api_search:");
      expect(result.content[0]!.text).toContain("User");
    });

    it("finds members by name", async () => {
      const result = await handleSearchApi({ query: "GetById" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("GetById");
    });

    it("finds by summary text", async () => {
      const result = await handleSearchApi({ query: "password" }, apiIndex);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("SetPassword");
    });

    it("returns no matches message", async () => {
      const result = await handleSearchApi({ query: "zzzznonexistent" }, apiIndex);
      expect(result.content[0]!.text).toBe("No matches found.");
    });

    it("rejects unsafe regex", async () => {
      const result = await handleSearchApi({ query: "(a+)+" }, apiIndex);
      expect(result.isError).toBe(true);
    });

    it("returns error when query is missing", async () => {
      const result = await handleSearchApi({} as { query: string }, apiIndex);
      expect(result.isError).toBe(true);
    });
  });
});
