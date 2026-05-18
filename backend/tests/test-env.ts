// Shared test env setup. Imported at the top of every test file BEFORE the
// modules under test so config.ts's startup validation sees valid values.
process.env.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN ?? 'a'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? '0'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/x';
process.env.ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'http://localhost:8080';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
