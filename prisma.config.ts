/**
 * Prisma config — schéma, migrations et URL utilisée par le CLI (migrate, studio).
 * Prisma 7 no longer loads env files: the local ones are loaded here with Node's own loader.
 * The CLI prefers DIRECT_URL (Supabase's session pooler, port 5432) and falls back on DATABASE_URL.
 * WARNING: through the transaction pooler (port 6543, DATABASE_URL) `migrate` hangs forever on its
 * advisory lock: set DIRECT_URL before migrating.
 */
import { defineConfig } from 'prisma/config';

for (const file of ['.env.local', '.env']) {
    try {
        process.loadEnvFile(file);
    } catch {
        // Missing file: variables come from the environment (Vercel, CI)
    }
}

export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: {
        url: process.env.DIRECT_URL || process.env.DATABASE_URL || '',
    },
});
