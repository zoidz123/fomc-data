# fed-mcp

MCP server for semantic search across the entire FOMC corpus — every statement and meeting minutes from 2000 to present.

Ask your AI assistant questions about Federal Reserve monetary policy, and it searches 25+ years of primary source documents using vector similarity.

## Background

The Federal Open Market Committee (FOMC) meets eight times a year to set US monetary policy. After each meeting they release a statement with their interest rate decision, economic outlook, and forward guidance. Detailed meeting minutes follow ~3 weeks later. These documents are the primary signal for how the Fed thinks about inflation, employment, and the economy — and they move markets immediately on release.

This server makes the full corpus of FOMC statements and minutes searchable by any MCP-compatible AI assistant.

## What it does

- **`search_fed_topic`** — Semantic search across all FOMC documents. Supports date range and document type filters.
- **`fetch_fed_documents_by_date_range`** — Fetch full documents within a date range, chronologically ordered.
- **`fetch_fed_document`** — Fetch a single document by meeting date and type.

## Example queries

```
"How has the Fed's language on inflation evolved from 2021 to 2023?"

"What did the FOMC say about balance sheet reduction in 2017-2019?"

"Show me the emergency COVID statement from March 15, 2020"

"Compare how the Fed discussed unemployment during the 2008 crisis vs 2020"
```

## Add to Claude Code

```bash
claude mcp add --transport http fed-mcp https://fomc-data-production.up.railway.app/mcp
```

## Add to Codex

```bash
codex mcp add fed-mcp --url https://fomc-data-production.up.railway.app/mcp
```

Or add directly to `~/.codex/config.toml`:

```toml
[mcp_servers.fed-mcp]
url = "https://fomc-data-production.up.railway.app/mcp"
```

## Architecture

Supabase (pgvector) for storage, OpenAI `text-embedding-3-small` for embeddings, cosine similarity search via a Postgres RPC function. ~1,200 FOMC documents chunked paragraph-aware.

## Data source

FOMC communications dataset from [vtasca/fed-statement-scraping](https://github.com/vtasca/fed-statement-scraping). Covers FOMC statements and minutes from 2000 to present, automatically scraped from the Federal Reserve website after each release.

## License

MIT
