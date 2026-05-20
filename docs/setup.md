# Setup, Environment & Secrets

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

## Environment Config

Supabase credentials are injected at build time. They are **never** committed.

- `.env.example` — template, checked in.
- `.env` — local secrets, **gitignored**. Copy from `.env.example`.
- `scripts/generate-env.js` — reads `process.env` (loading `.env` via dotenv when present), validates `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, and writes both `src/environments/environment.ts` and `environment.prod.ts`.
- `src/environments/environment.ts` and `environment.prod.ts` — **gitignored**, regenerated on every build/serve. Do not hand-edit.

Workflow:
- **Local dev** — `npm install` (one time), then `npm start`. The `prestart` hook runs the generator from `.env`.
- **CI / Vercel** — set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as project env vars. `prebuild` runs the generator before `ng build`.
- **Manual regen** — `npm run generate-env`.
- The generator exits non-zero if either var is missing — failing the build loudly is intentional.

`SupabaseService` imports `environment` from `src/environments/environment` and exposes a singleton `SupabaseClient` via `getClient()`. No component or other service may call `createClient` directly.

## LLM Vision (bank-screenshot import)

The `extract-transactions` edge function is the only consumer of the LLM API. All keys live in Supabase secrets, never in the Angular bundle.

Required Supabase secrets:
- `GEMINI_API_KEY` — from Google AI Studio. Free tier works out-of-box (~1,500 image requests/day, 15/min). Paid tier = enable billing on the same Google Cloud project; no code or key change needed.
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`. Swap by command: `supabase secrets set GEMINI_MODEL=gemini-2.5-pro` (or any other Gemini vision-capable model). The edge function reads this env var on every request, so changes take effect without redeploy.

The edge function's contract:
- Accepts `{ image: base64, accountId }` via authenticated POST (JWT in `Authorization` header).
- Server fetches the user's category list (RLS scopes it automatically) so prompts include only valid category ids.
- Calls Gemini with a structured-output schema matching `ImportDraft[]` minus `skip` (defaults to false on the client).
- Prompt includes today's date (so "Hari ini"/"Kemarin" resolves) and the user's category list (so `suggestedCategoryId` lands on an existing id, not a hallucinated one).
- Returns `ImportDraft[]` or a structured error (`quota_exceeded` / `parse_failed` / `unsupported_image`).

**Privacy note**: Gemini's free tier may use submitted images to improve Google models. Paid tier (any billing-enabled project) does not. For real bank screenshots, switch to paid before going beyond personal dev use.

## Group invitations

No edge function or SMTP. Group invitations are auto-bound on login — see `docs/groups.md` ("Invite flow — auto-bind on login"). The host shares the invitee's email out of band (verbally, chat, whatever); when the invitee signs in, `claim_invitations_for_email()` accepts every pending row that matches their `auth.users.email`.
