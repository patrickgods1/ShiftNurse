import { defineConfig } from 'drizzle-kit';

// Migrations are generated against a throwaway local file; at runtime the Electron main
// process opens the real database in userData. Generation only needs the schema shape.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: './.drizzle-scratch.sqlite' },
  strict: true,
  verbose: true,
});
