// Point the app's Prisma client at the test database before any module loads it.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
}

export const hasDb = Boolean(process.env.TEST_DATABASE_URL);

// Vitest can't load the TypeScript extraction worker; run adapters in-process.
process.env.TEXT_EXTRACT_WORKER ??= '0';

// Resume parsing and the AI features call a model provider when configured:
// a developer's .env must never make tests send anything. Suites that test
// them pass their own.
for (const name of Object.keys(process.env)) {
  if (name === 'GROQ_API_KEY' || name === 'RESUME_PARSER' || name.startsWith('RESUME_PARSER_') || name.startsWith('AI_')) delete process.env[name];
}
