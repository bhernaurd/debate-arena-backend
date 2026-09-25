-- 047_mirror_immutable_snapshot_evidence.sql
-- Freeze the evidence shown by completed Mirrors so historical reports remain
-- exact even if the underlying saved debate is later deleted or its
-- "exclude from future Mirrors" preference changes.

ALTER TABLE account_mirror_snapshots
    ADD COLUMN IF NOT EXISTS evidence_json JSONB;

WITH signal_payloads AS (
    SELECT
        sshot.id AS snapshot_id,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', sig.id::text,
                    'dimension', sig.dimension,
                    'pole', sig.pole,
                    'confidence', sig.confidence,
                    'stanceStrength', sig.stance_strength,
                    'contextBucket', sig.context_bucket,
                    'excerpt', sig.evidence_excerpt,
                    'positionSummary', sig.position_summary,
                    'sourceType', ev.source_type,
                    'savedDebateId', ev.saved_debate_id::text,
                    'philosopherName', hist.philosopher_name,
                    'topic', hist.topic,
                    'debateCompletedAt',
                        to_char(
                            ev.debate_completed_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        ),
                    'excludedFromFuture', sig.excluded_by_user,
                    'excludedAt',
                        CASE
                            WHEN sig.excluded_at IS NULL THEN NULL
                            ELSE to_char(
                                sig.excluded_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                            )
                        END
                )
                ORDER BY ev.debate_completed_at ASC, sig.ordinal ASC
            ) FILTER (
                WHERE sig.id IS NOT NULL
                  AND ev.status = 'accepted'
                  AND sig.validated = TRUE
            ),
            '[]'::jsonb
        ) AS signals
    FROM account_mirror_snapshots sshot
    LEFT JOIN account_mirror_debate_evidence ev
      ON ev.cycle_id = sshot.cycle_id
    LEFT JOIN account_mirror_evidence_signals sig
      ON sig.evidence_id = ev.id
    LEFT JOIN account_debate_history hist
      ON hist.id = ev.debate_history_id
    GROUP BY sshot.id
),
revision_payloads AS (
    SELECT
        sshot.id AS snapshot_id,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', rev.id::text,
                    'dimension', rev.dimension,
                    'beforePole', rev.before_pole,
                    'afterPole', rev.after_pole,
                    'confidence', rev.confidence,
                    'revisionStrength', rev.revision_strength,
                    'beforeExcerpt', rev.before_excerpt,
                    'afterExcerpt', rev.after_excerpt,
                    'revisionSummary', rev.revision_summary,
                    'sourceType', ev.source_type,
                    'savedDebateId', ev.saved_debate_id::text,
                    'philosopherName', hist.philosopher_name,
                    'topic', hist.topic,
                    'debateCompletedAt',
                        to_char(
                            ev.debate_completed_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        ),
                    'excludedFromFuture', rev.excluded_by_user,
                    'excludedAt',
                        CASE
                            WHEN rev.excluded_at IS NULL THEN NULL
                            ELSE to_char(
                                rev.excluded_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                            )
                        END
                )
                ORDER BY ev.debate_completed_at ASC
            ) FILTER (
                WHERE rev.id IS NOT NULL
                  AND ev.status = 'accepted'
                  AND rev.validated = TRUE
            ),
            '[]'::jsonb
        ) AS revisions
    FROM account_mirror_snapshots sshot
    LEFT JOIN account_mirror_debate_evidence ev
      ON ev.cycle_id = sshot.cycle_id
    LEFT JOIN account_mirror_revision_events rev
      ON rev.evidence_id = ev.id
    LEFT JOIN account_debate_history hist
      ON hist.id = ev.debate_history_id
    GROUP BY sshot.id
)
UPDATE account_mirror_snapshots AS snapshot
SET evidence_json = jsonb_build_object(
    'signals', signal_payloads.signals,
    'revisions', revision_payloads.revisions
)
FROM signal_payloads, revision_payloads
WHERE snapshot.id = signal_payloads.snapshot_id
  AND snapshot.id = revision_payloads.snapshot_id
  AND snapshot.evidence_json IS NULL;

COMMENT ON COLUMN account_mirror_snapshots.evidence_json IS
    'Immutable copy of the evidence shown when this Mirror completed. Historical snapshot reads use this JSON instead of mutable/deletable debate-history rows.';
