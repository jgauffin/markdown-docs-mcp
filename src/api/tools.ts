import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const API_TOOLS: Tool[] = [
  {
    name: "get_api_index",
    description:
      "Returns the API documentation index: all namespaces and types with summaries and member counts. Each type includes its source package (e.g. npm package / .NET assembly / crate name). Use get_api_type to drill into a specific type, or pass a package filter to narrow the index.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description:
            "Optional. Limit the index to types from this package (e.g. 'MyLib.Client', '@relax.js/core'). Use list_libraries first if you need to discover what's available.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_api_type",
    description:
      "Returns full documentation for an API type (class, interface, enum, etc.) including all members with their signatures and summaries. Supports partial name matching.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description:
            "Type name to look up. Can be short name (e.g., 'User'), full name (e.g., 'MyLib.Models.User'), or partial match.",
        },
        package: {
          type: "string",
          description:
            "Optional. Disambiguate when the same type name exists in multiple packages.",
        },
      },
      required: ["type_name"],
    },
  },
  {
    name: "get_api_member",
    description:
      "Returns detailed documentation for a specific member of a type, including parameters, return type, exceptions, and examples.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description: "The type that contains the member.",
        },
        member_name: {
          type: "string",
          description:
            "The member name to look up (e.g., 'GetById', 'Name', 'constructor').",
        },
        package: {
          type: "string",
          description:
            "Optional. Disambiguate when the same type name exists in multiple packages.",
        },
      },
      required: ["type_name", "member_name"],
    },
  },
  {
    name: "search_api",
    description:
      "Search API documentation using regex (case insensitive). Searches across type names, member names, signatures, and summaries. Optionally scope to a specific package.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Regex pattern to search for (case insensitive).",
        },
        package: {
          type: "string",
          description:
            "Optional. Limit results to types from this package.",
        },
      },
      required: ["query"],
    },
  },
];
