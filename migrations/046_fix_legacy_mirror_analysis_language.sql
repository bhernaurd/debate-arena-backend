-- 046_fix_legacy_mirror_analysis_language.sql
-- Mirror language-aware generation was deployed on 2026-09-24 at 17:40:19 UTC.
-- Every snapshot generated before that point was produced by the English-only
-- analysis prompt, even if the surrounding app UI was set to another language.
-- Correct those legacy canonical-language markers so on-demand translation
-- reliably runs for them.

UPDATE account_mirror_snapshots
SET analysis_language_code = 'en'
WHERE generated_at < TIMESTAMPTZ '2026-09-24 17:40:19+00'
  AND analysis_language_code <> 'en';
