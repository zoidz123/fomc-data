import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
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
// Shared helpers
// ---------------------------------------------------------------------------

async function embedQuery(openai: OpenAI, text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: text,
  });
  return response.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Tool 1: Search by topic
//
// Vector similarity search across chunks, with optional date range and
// document type filters. Results are returned in order of relevance
// (highest similarity first).
// ---------------------------------------------------------------------------

export const searchTopicInputSchema = z.object({
  query: z.string().min(1).describe("Natural language search query"),
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
    .describe("Filter by document type"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of chunks to return"),
});

export type SearchTopicInput = z.infer<typeof searchTopicInputSchema>;

export type SearchTopicResult = {
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

export async function searchTopic(
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

// ---------------------------------------------------------------------------
// Tool 2: Fetch documents by date range
//
// Returns full document text for all documents within a date range,
// ordered chronologically. Useful for reading through an era or comparing
// how language evolved over time.
// ---------------------------------------------------------------------------

export const fetchDocumentsByDateRangeInputSchema = z.object({
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
    .describe("Filter by document type"),
});

export type FetchDocumentsByDateRangeInput = z.infer<
  typeof fetchDocumentsByDateRangeInputSchema
>;

export type DocumentResult = {
  id: string;
  meeting_date: string;
  release_date: string;
  document_type: string;
  title: string;
  normalized_text: string;
};

export async function fetchDocumentsByDateRange(
  supabase: SupabaseClient,
  input: FetchDocumentsByDateRangeInput
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

// ---------------------------------------------------------------------------
// Tool 3: Fetch a specific document
//
// Returns a single document by meeting date and document type.
// ---------------------------------------------------------------------------

export const fetchDocumentInputSchema = z.object({
  meeting_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Meeting date (YYYY-MM-DD)"),
  document_type: z
    .enum(["statement", "minutes"])
    .describe("Document type"),
});

export type FetchDocumentInput = z.infer<typeof fetchDocumentInputSchema>;

export async function fetchDocument(
  supabase: SupabaseClient,
  input: FetchDocumentInput
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
// Tool definitions (for wiring into an LLM tool-use API)
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    name: "search_fed_topic",
    description:
      "Search FOMC statements and minutes by topic using semantic similarity. " +
      "Supports optional date range and document type filters. " +
      "Use this for open-ended questions like 'how has the Fed discussed inflation' " +
      "or 'what did the Fed say about unemployment in 2022-2023'.",
    parameters: searchTopicInputSchema,
  },
  {
    name: "fetch_fed_documents_by_date_range",
    description:
      "Fetch full FOMC documents (statements and/or minutes) within a date range, " +
      "returned in chronological order. Use this when you need to read through an era " +
      "(e.g. the Volcker period 1979-1982) or trace how language evolved over time.",
    parameters: fetchDocumentsByDateRangeInputSchema,
  },
  {
    name: "fetch_fed_document",
    description:
      "Fetch a single FOMC document by its exact meeting date and type. " +
      "Use this when the user asks about a specific meeting " +
      "(e.g. 'what did the March 2022 statement say').",
    parameters: fetchDocumentInputSchema,
  },
] as const;
