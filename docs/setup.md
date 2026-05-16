# Setup & Bootstrap

Project is already bootstrapped — this file is reference only.

## Initial bootstrap commands (historical)
```bash
# 1. Create project
npm install -g @ionic/cli
ionic start balance-tracker blank --type=angular --capacitor
cd balance-tracker

# 2. Install dependencies
npm install @supabase/supabase-js
npm install @capacitor/haptics
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init

# 3. Wire Tailwind into angular.json styles array:
#    "styles": ["src/global.scss", "src/theme/variables.scss"]
#    Add to src/global.scss:
#    @tailwind base;
#    @tailwind components;
#    @tailwind utilities;
```

## Day-to-day
```bash
# Local dev (regenerates environment files from .env via prestart hook)
npm start

# Build for web
npm run build

# Build for mobile
ionic build
npx cap sync
npx cap open ios     # or android

# Regenerate env files manually
npm run generate-env
```

## Environment variables
See `CLAUDE.md §10` — `SUPABASE_URL` and `SUPABASE_ANON_KEY` are required. `scripts/generate-env.js` writes them into `src/environments/environment{,.prod}.ts` at build/serve time. Both files and `.env` are gitignored; only `.env.example` is checked in.
