import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Static pages + one on-demand API route (/api/report) deployed as a Vercel function.
// Needs ELEVENLABS_API_KEY and ANTHROPIC_API_KEY in the environment.
export default defineConfig({
  output: 'static',
  adapter: vercel({ maxDuration: 60 }),
});
