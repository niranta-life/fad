-- Applied version: 20261025_001_event_prune_grants.
-- fad_s7_prune_retained runs as fad_bootstrap.
-- That role needs to delete retained rows and advance the stream watermark.
-- fad_app does not receive these grants. No down script.

GRANT SELECT, DELETE ON fad_event_delivery_attempts TO fad_bootstrap;
GRANT SELECT, DELETE ON fad_event_delivery_jobs TO fad_bootstrap;
GRANT SELECT, DELETE ON fad_outbox_events TO fad_bootstrap;
GRANT SELECT ON fad_event_replay_requests TO fad_bootstrap;
GRANT SELECT, UPDATE ON fad_event_streams TO fad_bootstrap;
