-- Forward repair for databases bootstrapped before enum ownership was part of
-- the moni_owner handoff. This migration is intentionally generic so every
-- currently-live public enum, including enums added after 0001, stays owned by
-- the designated DDL role.
--
-- An already-bootstrapped database whose enums are still owned by `postgres`
-- must run this once with the Docker superuser connection. A fresh bootstrap
-- already uses that connection; repaired/normal databases can run it as
-- moni_owner because that role already owns the enum objects.
DO $$
DECLARE
  enum_name text;
BEGIN
  FOR enum_name IN
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO moni_owner', enum_name);
  END LOOP;
END
$$;
