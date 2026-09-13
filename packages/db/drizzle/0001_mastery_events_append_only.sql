-- mastery_events is an append-only audit log; learner_concept_states is its projection.
-- Rows may be deleted (user data deletion cascades), but never rewritten.
CREATE OR REPLACE FUNCTION forbid_mastery_event_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mastery_events is append-only; record a new event instead of updating %', OLD.id;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER mastery_events_no_update
  BEFORE UPDATE ON mastery_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mastery_event_update();
