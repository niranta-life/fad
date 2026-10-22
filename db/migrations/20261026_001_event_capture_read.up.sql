-- Applied version: 20261026_001_event_capture_read.
-- fad_s7_writer_guard runs as fad_bootstrap.
-- That role must read the capture control row.
-- fad_app already has SELECT. No down script.

GRANT SELECT ON fad_event_capture_control TO fad_bootstrap;
