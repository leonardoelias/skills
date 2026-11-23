// Writes visual-diff.schema.json from src/schema.mjs (single source of truth).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA } from '../src/schema.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'visual-diff.schema.json');
writeFileSync(out, JSON.stringify(CONFIG_SCHEMA, null, 2) + '\n');
console.log(`wrote ${out}`);
