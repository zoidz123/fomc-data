with ranked_documents as (
  select
    id,
    row_number() over (
      partition by meeting_date, document_type
      order by updated_at desc, created_at desc, id desc
    ) as row_number
  from public.fed_documents
)
delete from public.fed_documents documents
using ranked_documents ranked
where documents.id = ranked.id
  and ranked.row_number > 1;

alter table public.fed_documents
drop constraint if exists fed_documents_meeting_date_release_date_document_type_key;

alter table public.fed_documents
add constraint fed_documents_meeting_date_document_type_key
unique (meeting_date, document_type);
