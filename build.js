// Tiny build step: copies index.html and app.js into dist/, replacing the
// __PLACEHOLDER__ config tokens with the corresponding environment variables.
// Run locally with a .env (see .env.example) or by Vercel during deploy.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const replacements = {
  __SUPABASE_URL__: process.env.SUPABASE_URL || '',
  __SUPABASE_ANON_KEY__: process.env.SUPABASE_ANON_KEY || '',
  __AUTH0_DOMAIN__: process.env.AUTH0_DOMAIN || '',
  __AUTH0_CLIENT_ID__: process.env.AUTH0_CLIENT_ID || '',
};

for (const [key, value] of Object.entries(replacements)) {
  if (!value) console.warn(`[build] warning: ${key} is not set`);
}

mkdirSync('dist', { recursive: true });

for (const file of ['index.html', 'app.js']) {
  let content = readFileSync(file, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    content = content.split(token).join(value);
  }
  writeFileSync(`dist/${file}`, content);
  console.log(`[build] wrote dist/${file}`);
}
