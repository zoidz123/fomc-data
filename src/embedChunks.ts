import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { z } from "zod";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const FETCH_BATCH_SIZE = 500;
const EMBED_BATCH_SIZE = 100;
const CONCURRENT_BATCHES = 3;
const DB_WRITE_CONCURRENCY = 10;
const MAX_RETRIES = 3;

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

type ChunkRow = {
  id: string;
  chunk_text: string;
};

async function fetchChunksWithoutEmbeddings(
  supabase: SupabaseClient
): Promise<ChunkRow[]> {
  const allChunks: ChunkRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("fed_document_chunks")
      .select("id, chunk_text")
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .range(from, from + FETCH_BATCH_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch chunks: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    allChunks.push(...(data as ChunkRow[]));

    if (data.length < FETCH_BATCH_SIZE) {
      break;
    }

    from += FETCH_BATCH_SIZE;
  }

  return allChunks;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function embedBatch(
  openai: OpenAI,
  texts: string[]
): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: texts,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

async function updateChunkEmbedding(
  supabase: SupabaseClient,
  chunkId: string,
  embedding: number[]
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { error } = await supabase
      .from("fed_document_chunks")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", chunkId);

    if (!error) return;

    if (attempt === MAX_RETRIES) {
      throw new Error(`Failed to update chunk ${chunkId} after ${MAX_RETRIES} attempts: ${error.message}`);
    }

    console.warn(`[embed] retry ${attempt}/${MAX_RETRIES} for chunk ${chunkId}`);
    await Bun.sleep(attempt * 2000);
  }
}

async function writeEmbeddingsWithThrottle(
  supabase: SupabaseClient,
  items: { id: string; embedding: number[] }[]
): Promise<void> {
  const groups = chunkArray(items, DB_WRITE_CONCURRENCY);
  for (const group of groups) {
    await Promise.all(
      group.map((item) => updateChunkEmbedding(supabase, item.id, item.embedding))
    );
  }
}

async function main() {
  const env = envSchema.parse(process.env);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  console.log("[embed] fetching chunks without embeddings...");
  const chunks = await fetchChunksWithoutEmbeddings(supabase);

  if (chunks.length === 0) {
    console.log("[embed] all chunks already have embeddings, nothing to do");
    return;
  }

  console.log(`[embed] found ${chunks.length} chunks to embed`);

  const batches = chunkArray(chunks, EMBED_BATCH_SIZE);
  let processedCount = 0;

  // Process batches in concurrent waves for speed
  const waves = chunkArray(batches, CONCURRENT_BATCHES);

  for (const [waveIndex, wave] of waves.entries()) {
    const waveOffset = waveIndex * CONCURRENT_BATCHES;

    await Promise.all(
      wave.map(async (batch, i) => {
        const batchIndex = waveOffset + i;
        console.log(
          `[embed] processing batch ${batchIndex + 1}/${batches.length} (${batch.length} chunks)`
        );

        const texts = batch.map((chunk) => chunk.chunk_text);
        const embeddings = await embedBatch(openai, texts);

        // Write embeddings back with throttled concurrency
        await writeEmbeddingsWithThrottle(
          supabase,
          batch.map((chunk, j) => ({ id: chunk.id, embedding: embeddings[j] }))
        );
      })
    );

    processedCount += wave.reduce((sum, b) => sum + b.length, 0);
    console.log(
      `[embed] wave ${waveIndex + 1}/${waves.length} done — ${processedCount}/${chunks.length} total`
    );
  }

  console.log(`[embed] done — embedded ${processedCount} chunks`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
