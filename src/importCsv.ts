import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { chunkDocument, normalizeDocumentText } from "./chunking";

const DOCUMENT_BATCH_SIZE = 100;
const CHUNK_DELETE_BATCH_SIZE = 25;
const CHUNK_BATCH_SIZE = 500;

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  FED_COMMUNICATIONS_CSV_URL: z.string().url().optional(),
  FED_COMMUNICATIONS_CSV_PATH: z.string().min(1).optional(),
  FULL_REBUILD: z.string().optional()
});

const rowSchema = z.object({
  Date: z.string().min(1),
  "Release Date": z.string(),
  Type: z.string().min(1),
  Text: z.string().min(1)
});

type CsvRow = z.infer<typeof rowSchema>;
type DocumentType = "statement" | "minutes";

type DocumentRecord = {
  id: string;
  meeting_date: string;
  release_date: string;
  document_type: DocumentType;
  title: string;
  source_url: string | null;
  raw_text: string;
  normalized_text: string;
  text_sha256: string;
};

type ExistingDocument = {
  id: string;
  meeting_date: string;
  document_type: DocumentType;
  text_sha256: string;
};

type ChunkRecord = {
  id: string;
  document_id: string;
  chunk_index: number;
  chunk_text: string;
  token_count: number;
  char_count: number;
  start_paragraph_index: number;
  end_paragraph_index: number;
};

function normalizeDocumentType(value: string): DocumentType {
  const normalized = value.trim().toLowerCase();
  if (normalized === "statement" || normalized === "statements") {
    return "statement";
  }

  if (normalized === "minute" || normalized === "minutes") {
    return "minutes";
  }

  throw new Error(`Unsupported document type: ${value}`);
}

function buildTitle(documentType: "statement" | "minutes", meetingDate: string): string {
  return documentType === "statement"
    ? `FOMC Statement - ${meetingDate}`
    : `FOMC Minutes - ${meetingDate}`;
}

function normalizeReleaseDate(meetingDate: string, releaseDate: string): string {
  const normalized = releaseDate.trim();
  return normalized.length > 0 ? normalized : meetingDate;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function documentKey(meetingDate: string, documentType: DocumentType): string {
  return `${meetingDate}:${documentType}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function withRetry<T>(
  label: string,
  operation: () => PromiseLike<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.warn(`[import] ${label} failed on attempt ${attempt}, retrying`, error);
      await Bun.sleep(attempt * 1000);
    }
  }

  throw lastError;
}

async function fetchCsv(url: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`[import] fetching CSV from URL (attempt ${attempt}): ${url}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch CSV: ${response.status} ${response.statusText}`);
      }

      return response.text();
    } catch (error) {
      lastError = error;
      await Bun.sleep(attempt * 1000);
    }
  }

  throw lastError;
}

async function loadCsvSource(env: z.infer<typeof envSchema>): Promise<string> {
  if (env.FED_COMMUNICATIONS_CSV_PATH) {
    console.log(`[import] loading CSV from local path: ${env.FED_COMMUNICATIONS_CSV_PATH}`);
    return readFile(env.FED_COMMUNICATIONS_CSV_PATH, "utf8");
  }

  if (!env.FED_COMMUNICATIONS_CSV_URL) {
    throw new Error("Set either FED_COMMUNICATIONS_CSV_PATH or FED_COMMUNICATIONS_CSV_URL.");
  }

  console.log(`[import] no local CSV path configured, falling back to URL`);
  return fetchCsv(env.FED_COMMUNICATIONS_CSV_URL);
}

async function fetchExistingDocuments(
  supabase: SupabaseClient
): Promise<Map<string, ExistingDocument>> {
  const existingDocuments = new Map<string, ExistingDocument>();
  let from = 0;

  while (true) {
    const { data, error } = await withRetry("fetch existing documents", () =>
      supabase
        .from("fed_documents")
        .select("id, meeting_date, document_type, text_sha256")
        .order("meeting_date", { ascending: true })
        .order("document_type", { ascending: true })
        .range(from, from + 999)
    );

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const document of data as ExistingDocument[]) {
      existingDocuments.set(
        documentKey(document.meeting_date, document.document_type),
        document
      );
    }

    if (data.length < 1000) {
      break;
    }

    from += 1000;
  }

  return existingDocuments;
}

async function main() {
  const env = envSchema.parse(process.env);
  console.log("[import] starting import");
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false }
  });

  const csvText = await loadCsvSource(env);
  console.log(`[import] loaded CSV source (${csvText.length} chars)`);
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true
  }) as Record<string, string>[];
  console.log(`[import] parsed ${rows.length} CSV rows`);

  const parsedDocuments = new Map<string, DocumentRecord>();

  for (const [rowIndex, rawRow] of rows.entries()) {
    const row = rowSchema.parse(rawRow) as CsvRow;
    const documentType = normalizeDocumentType(row.Type);
    const releaseDate = normalizeReleaseDate(row.Date, row["Release Date"]);
    const normalizedText = normalizeDocumentText(row.Text);
    const record: DocumentRecord = {
      id: randomUUID(),
      meeting_date: row.Date,
      release_date: releaseDate,
      document_type: documentType,
      title: buildTitle(documentType, row.Date),
      source_url: env.FED_COMMUNICATIONS_CSV_URL ?? null,
      raw_text: row.Text,
      normalized_text: normalizedText,
      text_sha256: sha256(normalizedText)
    };

    if (rowIndex % 25 === 0) {
      console.log(
        `[import] processing row ${rowIndex + 1}/${rows.length}: ${row.Date} ${documentType}`
      );
    }

    parsedDocuments.set(documentKey(record.meeting_date, record.document_type), record);
  }

  const fullRebuild = env.FULL_REBUILD === "true";
  const existingDocuments = fullRebuild ? new Map<string, ExistingDocument>() : await fetchExistingDocuments(supabase);
  console.log(`[import] loaded ${existingDocuments.size} existing documents from database`);

  const documentsToWrite = Array.from(parsedDocuments.values()).filter((document) => {
    const existingDocument = existingDocuments.get(
      documentKey(document.meeting_date, document.document_type)
    );
    return !existingDocument || existingDocument.text_sha256 !== document.text_sha256;
  });

  const insertedDocuments = documentsToWrite.filter((document) => {
    return !existingDocuments.has(documentKey(document.meeting_date, document.document_type));
  }).length;
  const updatedDocuments = documentsToWrite.length - insertedDocuments;
  const skippedDocuments = parsedDocuments.size - documentsToWrite.length;

  console.log(
    `[import] diff summary: total=${parsedDocuments.size}, new=${insertedDocuments}, updated=${updatedDocuments}, unchanged=${skippedDocuments}`
  );

  if (documentsToWrite.length === 0) {
    console.log("[import] no document changes detected");
    return;
  }

  const persistedDocuments = new Map<string, ExistingDocument>();

  if (existingDocuments.size === 0) {
    for (const [batchIndex, batch] of chunkArray(documentsToWrite, DOCUMENT_BATCH_SIZE).entries()) {
      console.log(
        `[import] inserting document batch ${batchIndex + 1}: ${batch.length} documents`
      );
      const { data, error } = await withRetry("insert documents", () =>
        supabase
          .from("fed_documents")
          .insert(batch)
          .select("id, meeting_date, document_type, text_sha256")
      );

      if (error) {
        console.error("[import] failed document insert batch", error);
        throw error;
      }

      for (const document of data as ExistingDocument[]) {
        persistedDocuments.set(
          documentKey(document.meeting_date, document.document_type),
          document
        );
      }
    }
  } else {
    for (const [batchIndex, batch] of chunkArray(documentsToWrite, DOCUMENT_BATCH_SIZE).entries()) {
      console.log(
        `[import] upserting document batch ${batchIndex + 1}: ${batch.length} documents`
      );
      const { data, error } = await withRetry("upsert documents", () =>
        supabase
          .from("fed_documents")
          .upsert(batch, {
            onConflict: "meeting_date,document_type"
          })
          .select("id, meeting_date, document_type, text_sha256")
      );

      if (error) {
        console.error("[import] failed document upsert batch", error);
        throw error;
      }

      for (const document of data as ExistingDocument[]) {
        persistedDocuments.set(
          documentKey(document.meeting_date, document.document_type),
          document
        );
      }
    }

    const documentIdsToRefresh = Array.from(persistedDocuments.values()).map((document) => document.id);
    for (const [batchIndex, batch] of chunkArray(documentIdsToRefresh, CHUNK_DELETE_BATCH_SIZE).entries()) {
      console.log(
        `[import] clearing chunk batch ${batchIndex + 1}: ${batch.length} documents`
      );
      const { error } = await withRetry("delete existing chunks", () =>
        supabase.from("fed_document_chunks").delete().in("document_id", batch)
      );

      if (error) {
        console.error("[import] failed chunk delete batch", error);
        throw error;
      }

      console.log(
        `[import] cleared chunk batch ${batchIndex + 1}: ${batch.length} documents`
      );
    }
  }

  const chunkRecords: ChunkRecord[] = [];
  for (const document of documentsToWrite) {
    const persistedDocument = persistedDocuments.get(
      documentKey(document.meeting_date, document.document_type)
    );

    if (!persistedDocument) {
      throw new Error(
        `Missing upserted document id for ${document.meeting_date} ${document.document_type}`
      );
    }

    const chunks = chunkDocument(document.normalized_text);
    console.log(
      `[import] generated ${chunks.length} chunks for ${document.meeting_date} ${document.document_type}`
    );

    for (const [chunkIndex, chunk] of chunks.entries()) {
      chunkRecords.push({
        id: randomUUID(),
        document_id: persistedDocument.id,
        chunk_index: chunkIndex,
        chunk_text: chunk.chunkText,
        token_count: chunk.tokenCount,
        char_count: chunk.charCount,
        start_paragraph_index: chunk.startParagraphIndex,
        end_paragraph_index: chunk.endParagraphIndex
      });
    }
  }

  let insertedChunks = 0;
  for (const [batchIndex, batch] of chunkArray(chunkRecords, CHUNK_BATCH_SIZE).entries()) {
    console.log(`[import] inserting chunk batch ${batchIndex + 1}: ${batch.length} chunks`);
    const { error } = await withRetry("insert chunks", () =>
      supabase.from("fed_document_chunks").insert(batch)
    );

    if (error) {
      console.error("[import] failed chunk insert batch", error);
      throw error;
    }

    insertedChunks += batch.length;
  }

  console.log(
    `[import] completed: processed=${parsedDocuments.size}, inserted_documents=${insertedDocuments}, updated_documents=${updatedDocuments}, skipped_documents=${skippedDocuments}, inserted_chunks=${insertedChunks}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
