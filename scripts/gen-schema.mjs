#!/usr/bin/env node
/**
 * One source schema, two engines.
 *
 * prisma/schema.prisma is the Postgres source of truth. This script derives
 * prisma/schema.sqlite.prisma from it, so the models are written once:
 *   - enums become String fields (SQLite has no enum type)
 *   - list fields (String[]) become JSON text columns
 *   - @db.Date becomes DateTime
 *   - Postgres-only extensions and GIN/trigram indexes are dropped
 *
 * Usage:
 *   node scripts/gen-schema.mjs sqlite      # writes prisma/schema.sqlite.prisma
 *   node scripts/gen-schema.mjs postgresql  # copies the source as-is
 *
 * The chosen engine is then selected by DATABASE_PROVIDER (see src/lib/db.ts).
 * Prisma generates one client at a time, so switching engines means running
 * this script and `prisma generate` again. See docs/database.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'prisma', 'schema.prisma');
const target = process.argv[2] ?? 'postgresql';

if (!['sqlite', 'postgresql'].includes(target)) {
  console.error(`Unknown engine "${target}". Use "sqlite" or "postgresql".`);
  process.exit(1);
}

const src = readFileSync(source, 'utf8');

if (target === 'postgresql') {
  writeFileSync(path.join(root, 'prisma', 'schema.generated.prisma'), src);
  console.log('wrote prisma/schema.generated.prisma (postgresql)');
  process.exit(0);
}

// 1. Enum names, so fields of those types can be turned into String.
const enumNames = new Set([...src.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));

// 2. Split off the enum blocks; they are dropped in SQLite.
let out = src.replace(/^enum\s+\w+\s*\{[\s\S]*?^\}\s*$/gm, '');

// 3. Datasource + generator headers.
out = out.replace(
  /datasource db \{[\s\S]*?\n\}/,
  `datasource db {
  provider = "sqlite"
  url      = env("SQLITE_URL")
}`,
);
out = out.replace(/previewFeatures\s*=\s*\[[^\]]*\]\n?/, (m) =>
  m.replace(/"postgresqlExtensions",?\s*/, '').replace(/,\s*\]/, ']'),
);
out = out.replace(/^\s*extensions\s*=\s*\[[^\]]*\]\s*$/gm, '');

// 4. Index lines that rely on Postgres-only index types or operators.
out = out
  .split('\n')
  .filter((line) => !/@@index\(.*(type:\s*Gin|gin_trgm_ops)/.test(line))
  .join('\n');

// 5. Field-level rewrites.
const fieldLine = /^(\s+)(\w+)(\s+)(\w+)(\??|\[\])?(\s.*)?$/;
out = out
  .split('\n')
  .map((line) => {
    const m = line.match(fieldLine);
    if (!m || line.trimStart().startsWith('@@') || line.trimStart().startsWith('//')) return line;
    const [, indent, name, gap, type, mod = '', rest = ''] = m;
    if (!/^[A-Z]/.test(type) && !enumNames.has(type)) {
      // Scalar types only (String, Int, DateTime, Json, Boolean ...), plus list fields below.
    }
    // Scalar list fields (String[], Int[]): stored as JSON text.
    if (mod === '[]' && ['String', 'Int', 'Float', 'Boolean', 'DateTime'].includes(type)) {
      return `${indent}${name}${gap}Json @default("[]")`;
    }
    // Enums become plain strings.
    if (enumNames.has(type) && (mod === '' || mod === '?')) {
      return `${indent}${name}${gap}String${mod}${rest.replace(/@default\((\w+)\)/, '@default("$1")')}`;
    }
    // Date-only columns become DateTime.
    return line.replace(/\s*@db\.Date\b/, '');
  })
  .join('\n');

// 6. Collapse the blank lines the enum removal leaves behind.
out = out.replace(/\n{3,}/g, '\n\n');

const header = `// GENERATED from prisma/schema.prisma by scripts/gen-schema.mjs. Do not edit.\n// SQLite build: enums are strings, list fields are JSON text, no GIN/trigram indexes.\n`;
writeFileSync(path.join(root, 'prisma', 'schema.generated.prisma'), header + out);
console.log(`wrote prisma/schema.generated.prisma (sqlite), ${enumNames.size} enums flattened`);
