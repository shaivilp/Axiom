import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const isProdEnv = process.env.NODE_ENV === 'production';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // H3: minimum 24 chars from a safe charset. Rules out lazy / dictionary
    // tokens like `passwordpassword` while remaining easy to generate with
    // `openssl rand -hex 32` (64 hex chars).
    DASHBOARD_TOKEN: z
      .string()
      .min(24, 'DASHBOARD_TOKEN must be at least 24 characters')
      .regex(
        /^[A-Za-z0-9_-]+$/,
        'DASHBOARD_TOKEN must contain only [A-Za-z0-9_-] (no whitespace or special chars)',
      ),

    TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)'),

    DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres URL'),

    ALLOWED_ORIGIN: z
      .string()
      .url('ALLOWED_ORIGIN must be a valid URL')
      .default('http://localhost:8080'),

    // Optional: tighten the proxy-trust setting (H1). Defaults to `loopback`
    // so the rate limiter keys on the real client IP via nginx on the same
    // host, but in alternative deploys the operator can override.
    TRUST_PROXY: z.string().default('loopback'),
  })
  .superRefine((data, ctx) => {
    // H6: in production, reject plain-HTTP ALLOWED_ORIGIN. Bearer would
    // otherwise leak to any on-path observer.
    if (data.NODE_ENV === 'production' && data.ALLOWED_ORIGIN.startsWith('http://')) {
      // Allow the docker-compose default `http://localhost:8080` only if
      // the operator hasn't explicitly set it (the default value).
      const url = new URL(data.ALLOWED_ORIGIN);
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        ctx.addIssue({
          path: ['ALLOWED_ORIGIN'],
          code: z.ZodIssueCode.custom,
          message:
            'ALLOWED_ORIGIN must use https:// in production (current scheme leaks the session cookie / bearer to on-path observers)',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

function parseConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\n`);
    process.exit(1);
  }
  return result.data;
}

export const config: AppConfig = parseConfig();

export const isProd = config.NODE_ENV === 'production';
export const isDev = config.NODE_ENV === 'development';

// Re-export for callers that need a quick prod check before config loads
// (avoids a circular import).
export { isProdEnv };
