-- For databases created before passkeys (the Sandbox D1). New databases get these from schema.sql.
ALTER TABLE proposals ADD COLUMN decided_by TEXT;
ALTER TABLE audit_log ADD COLUMN actor TEXT;
