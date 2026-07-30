-- verify_009_account_ranked_completion_requests.sql
-- Read-only verification for migration 009.

SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'account_ranked_debates'
  AND column_name = 'completion_request_id';

SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'account_ranked_debates'
  AND indexname =
      'account_ranked_debates_completion_request_idx';

SELECT
    conname,
    pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid =
    'public.account_ranked_debates'::regclass
  AND conname =
      'account_ranked_debates_completion_request_status_check';
