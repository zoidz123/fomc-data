import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createClients,
  searchTopic,
  fetchDocumentsByDateRange,
  fetchDocument,
} from "./tools.js";

const { supabase, openai } = createClients();

const server = new McpServer({
  name: "fed-corpus-rag",
  version: "0.0.1",
});

// ---------------------------------------------------------------------------
// Tool 1: Semantic search across FOMC documents
// ---------------------------------------------------------------------------

server.registerTool(
  "search_fed_topic",
  {
    title: "Search Fed Topic",
    description:
      "Search FOMC statements and minutes by topic using semantic similarity. " +
      "Supports optional date range and document type filters. " +
      "Use this for open-ended questions like 'how has the Fed discussed inflation' " +
      "or 'what did the Fed say about unemployment in 2022-2023'. " +
      "Returns relevant text chunks ordered by similarity.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Start date filter (YYYY-MM-DD)"),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("End date filter (YYYY-MM-DD)"),
      document_type: z
        .enum(["statement", "minutes"])
        .optional()
        .describe("Filter by document type: 'statement' or 'minutes'"),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of chunks to return (default 10, max 50)"),
    },
  },
  async (input) => {
    const results = await searchTopic(supabase, openai, {
      query: input.query,
      date_from: input.date_from,
      date_to: input.date_to,
      document_type: input.document_type,
      max_results: input.max_results ?? 10,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No matching documents found for the given query and filters.",
          },
        ],
      };
    }

    const formatted = results.map((r, i) => {
      return [
        `--- Result ${i + 1} ---`,
        `Title: ${r.title}`,
        `Meeting Date: ${r.meeting_date}`,
        `Type: ${r.document_type}`,
        `Similarity: ${r.similarity.toFixed(4)}`,
        ``,
        r.chunk_text,
      ].join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${results.length} relevant chunks:\n\n${formatted.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 2: Fetch documents by date range
// ---------------------------------------------------------------------------

server.registerTool(
  "fetch_fed_documents_by_date_range",
  {
    title: "Fetch Fed Documents by Date Range",
    description:
      "Fetch full FOMC documents (statements and/or minutes) within a date range, " +
      "returned in chronological order. Use this when you need to read through an era " +
      "(e.g. the Volcker period 1979-1982) or trace how language evolved over time. " +
      "Returns the full normalized text of each document.",
    inputSchema: {
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Start date (YYYY-MM-DD)"),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End date (YYYY-MM-DD)"),
      document_type: z
        .enum(["statement", "minutes"])
        .optional()
        .describe("Filter by document type: 'statement' or 'minutes'"),
    },
  },
  async (input) => {
    const docs = await fetchDocumentsByDateRange(supabase, {
      date_from: input.date_from,
      date_to: input.date_to,
      document_type: input.document_type,
    });

    if (docs.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No documents found in the given date range.",
          },
        ],
      };
    }

    const formatted = docs.map((doc) => {
      return [
        `${"=".repeat(60)}`,
        `${doc.title}`,
        `Meeting Date: ${doc.meeting_date} | Release Date: ${doc.release_date}`,
        `${"=".repeat(60)}`,
        ``,
        doc.normalized_text,
      ].join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${docs.length} documents:\n\n${formatted.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 3: Fetch a specific document
// ---------------------------------------------------------------------------

server.registerTool(
  "fetch_fed_document",
  {
    title: "Fetch Fed Document",
    description:
      "Fetch a single FOMC document by its exact meeting date and type (statement or minutes). " +
      "Use this when the user asks about a specific meeting " +
      "(e.g. 'what did the March 2022 statement say').",
    inputSchema: {
      meeting_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Meeting date (YYYY-MM-DD)"),
      document_type: z
        .enum(["statement", "minutes"])
        .describe("Document type: 'statement' or 'minutes'"),
    },
  },
  async (input) => {
    const doc = await fetchDocument(supabase, {
      meeting_date: input.meeting_date,
      document_type: input.document_type,
    });

    if (!doc) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No ${input.document_type} found for meeting date ${input.meeting_date}.`,
          },
        ],
      };
    }

    const formatted = [
      `${doc.title}`,
      `Meeting Date: ${doc.meeting_date} | Release Date: ${doc.release_date}`,
      ``,
      doc.normalized_text,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
