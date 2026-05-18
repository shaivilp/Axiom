import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DASHBOARD_TOKEN: z
    .string()
    .min(16, 'DASHBOARD_TOKEN must be at least 16 characters'),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)'),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres URL'),

  ALLOWED_ORIGIN: z.string().url('ALLOWED_ORIGIN must be a valid URL').default('http://localhost:8080'),
});

export type AppConfig = z.infer<typeof envSchema>;

function parseConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Print to stderr and exit — fail fast before anything else boots.
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\n`);
    process.exit(1);
  }
  return result.data;
}

export const config: AppConfig = parseConfig();

export const isProd = config.NODE_ENV === 'production';
export const isDev = config.NODE_ENV === 'development';
