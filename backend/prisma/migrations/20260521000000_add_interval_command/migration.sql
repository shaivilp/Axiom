-- Global interval-command config on the single-row settings table. A repeating
-- command (or rotating list) every bot runs on a fixed interval. Defaults to an
-- empty object; zod fills in the disabled-by-default config on read.
ALTER TABLE "settings" ADD COLUMN "intervalCommand" JSONB NOT NULL DEFAULT '{}';
