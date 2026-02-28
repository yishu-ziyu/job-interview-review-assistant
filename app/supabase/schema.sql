create table if not exists public.interview_reviews (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  target_role text not null,
  company text,
  interview_round text,
  raw_notes text not null,
  review_json jsonb not null,
  llm_provider text not null,
  llm_model text not null,
  llm_raw_output text not null
);

create index if not exists idx_interview_reviews_created_at
  on public.interview_reviews (created_at desc);
