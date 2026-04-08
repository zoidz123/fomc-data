import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OpenAI from "openai";
import { z } from "zod";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

// ---------------------------------------------------------------------------
// Environment & clients
// ---------------------------------------------------------------------------

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

export function createClients() {
  const env = envSchema.parse(process.env);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return { supabase, openai };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

async function embedQuery(openai: OpenAI, text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: text,
  });
  return response.data[0].embedding;
}

type SearchTopicInput = {
  query: string;
  date_from?: string;
  date_to?: string;
  document_type?: "statement" | "minutes";
  max_results: number;
};

type SearchTopicResult = {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  chunk_text: string;
  token_count: number;
  similarity: number;
  meeting_date: string;
  document_type: string;
  title: string;
};

async function searchTopic(
  supabase: SupabaseClient,
  openai: OpenAI,
  input: SearchTopicInput
): Promise<SearchTopicResult[]> {
  const queryEmbedding = await embedQuery(openai, input.query);

  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: input.max_results,
    filter_date_from: input.date_from ?? null,
    filter_date_to: input.date_to ?? null,
    filter_document_type: input.document_type ?? null,
  });

  if (error) {
    throw new Error(`match_chunks failed: ${error.message}`);
  }

  return data as SearchTopicResult[];
}

type DocumentResult = {
  id: string;
  meeting_date: string;
  release_date: string;
  document_type: string;
  title: string;
  normalized_text: string;
};

async function fetchDocumentsByDateRange(
  supabase: SupabaseClient,
  input: { date_from: string; date_to: string; document_type?: string }
): Promise<DocumentResult[]> {
  let query = supabase
    .from("fed_documents")
    .select("id, meeting_date, release_date, document_type, title, normalized_text")
    .gte("meeting_date", input.date_from)
    .lte("meeting_date", input.date_to)
    .order("meeting_date", { ascending: true });

  if (input.document_type) {
    query = query.eq("document_type", input.document_type);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`fetchDocumentsByDateRange failed: ${error.message}`);
  }

  return data as DocumentResult[];
}

async function fetchDocument(
  supabase: SupabaseClient,
  input: { meeting_date: string; document_type: string }
): Promise<DocumentResult | null> {
  const { data, error } = await supabase
    .from("fed_documents")
    .select("id, meeting_date, release_date, document_type, title, normalized_text")
    .eq("meeting_date", input.meeting_date)
    .eq("document_type", input.document_type)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchDocument failed: ${error.message}`);
  }

  return data as DocumentResult | null;
}

// ---------------------------------------------------------------------------
// MCP tool registration — shared by both stdio and HTTP servers
// ---------------------------------------------------------------------------

export function registerTools(
  server: McpServer,
  supabase: SupabaseClient,
  openai: OpenAI
) {
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
          content: [{ type: "text" as const, text: "No matching documents found for the given query and filters." }],
        };
      }

      const formatted = results.map((r, i) =>
        [
          `--- Result ${i + 1} ---`,
          `Title: ${r.title}`,
          `Meeting Date: ${r.meeting_date}`,
          `Type: ${r.document_type}`,
          `Similarity: ${r.similarity.toFixed(4)}`,
          ``,
          r.chunk_text,
        ].join("\n")
      );

      return {
        content: [{ type: "text" as const, text: `Found ${results.length} relevant chunks:\n\n${formatted.join("\n\n")}` }],
      };
    }
  );

  server.registerTool(
    "fetch_fed_documents_by_date_range",
    {
      title: "Fetch Fed Documents by Date Range",
      description:
        "Fetch full FOMC documents (statements and/or minutes) within a date range, " +
        "returned in chronological order. Use this when you need to read through an era " +
        "or trace how language evolved over time. " +
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
          content: [{ type: "text" as const, text: "No documents found in the given date range." }],
        };
      }

      const formatted = docs.map((doc) =>
        [
          `${"=".repeat(60)}`,
          doc.title,
          `Meeting Date: ${doc.meeting_date} | Release Date: ${doc.release_date}`,
          `${"=".repeat(60)}`,
          ``,
          doc.normalized_text,
        ].join("\n")
      );

      return {
        content: [{ type: "text" as const, text: `Found ${docs.length} documents:\n\n${formatted.join("\n\n")}` }],
      };
    }
  );

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
          content: [{ type: "text" as const, text: `No ${input.document_type} found for meeting date ${input.meeting_date}.` }],
        };
      }

      const formatted = [
        doc.title,
        `Meeting Date: ${doc.meeting_date} | Release Date: ${doc.release_date}`,
        ``,
        doc.normalized_text,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    }
  );
}
