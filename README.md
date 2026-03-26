# fed-corpus-rag

Local ingestion pipeline for FOMC statements and minutes into Supabase-backed tables for chunked retrieval.

## Scope

- Fetch the public `communications.csv` dataset
- Normalize each row into `fed_documents`
- Chunk each document into `fed_document_chunks`
- Leave embeddings and query tools for the next step

## Setup

1. Copy `.env.example` to `.env`
2. Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY`
3. Link the repo to your Supabase project with `supabase link --project-ref <project-ref>`
4. Run `supabase db push`
5. Run `bun install`
6. Run `bun run import:csv`

## Notes

- This first pass does not generate embeddings yet
- Chunking is deterministic and paragraph-aware
- The importer is idempotent on `(meeting_date, release_date, document_type)`
- The canonical database schema lives in `supabase/migrations/`
- If the remote CSV download is flaky, set `FED_COMMUNICATIONS_CSV_PATH` to a local file and the importer will use that instead of the URL
