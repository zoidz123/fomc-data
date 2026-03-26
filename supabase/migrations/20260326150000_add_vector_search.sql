-- HNSW index for fast cosine similarity search on chunk embeddings.
create index if not exists fed_document_chunks_embedding_idx
  on public.fed_document_chunks
  using hnsw (embedding vector_cosine_ops);

-- Vector similarity search with optional date range and document type filters.
-- Returns chunks ordered by cosine similarity, joined with document metadata.
create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_count int default 10,
  filter_date_from date default null,
  filter_date_to date default null,
  filter_document_type text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  chunk_index int,
  chunk_text text,
  token_count int,
  similarity float,
  meeting_date date,
  document_type text,
  title text
)
language sql stable
as $$
  select
    c.id as chunk_id,
    c.document_id,
    c.chunk_index,
    c.chunk_text,
    c.token_count,
    1 - (c.embedding <=> query_embedding) as similarity,
    d.meeting_date,
    d.document_type,
    d.title
  from public.fed_document_chunks c
  join public.fed_documents d on d.id = c.document_id
  where c.embedding is not null
    and (filter_date_from is null or d.meeting_date >= filter_date_from)
    and (filter_date_to is null or d.meeting_date <= filter_date_to)
    and (filter_document_type is null or d.document_type = filter_document_type)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
