create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create table if not exists public.fed_documents (
  id uuid primary key,
  meeting_date date not null,
  release_date date not null,
  document_type text not null check (document_type in ('statement', 'minutes')),
  title text not null,
  source_url text,
  source_name text not null default 'vtasca/fed-statement-scraping',
  raw_text text not null,
  normalized_text text not null,
  text_sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meeting_date, release_date, document_type)
);

create table if not exists public.fed_document_chunks (
  id uuid primary key,
  document_id uuid not null references public.fed_documents(id) on delete cascade,
  chunk_index integer not null,
  chunk_text text not null,
  token_count integer not null,
  char_count integer not null,
  start_paragraph_index integer,
  end_paragraph_index integer,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists fed_documents_meeting_date_idx
  on public.fed_documents (meeting_date desc);

create index if not exists fed_documents_type_meeting_date_idx
  on public.fed_documents (document_type, meeting_date desc);

create index if not exists fed_documents_release_date_idx
  on public.fed_documents (release_date desc);

create index if not exists fed_document_chunks_document_id_idx
  on public.fed_document_chunks (document_id, chunk_index);

create index if not exists fed_document_chunks_text_trgm_idx
  on public.fed_document_chunks
  using gin (chunk_text gin_trgm_ops);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_fed_documents_updated_at on public.fed_documents;

create trigger set_fed_documents_updated_at
before update on public.fed_documents
for each row
execute function public.set_updated_at();
