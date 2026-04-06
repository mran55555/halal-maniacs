# Halal Maniacs 🍽️

Halal restaurant finder with AI-powered search, verification calling, favorites, and a 2,247-restaurant California database.

## Deploy to Vercel (5 minutes)

### Step 1: Get an Anthropic API Key
1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account → API Keys → Create Key
3. Copy the key (starts with `sk-ant-`)

### Step 2: Push to GitHub
```bash
# Create a new repo on github.com, then:
git init
git add .
git commit -m "Halal Maniacs v1"
git remote add origin https://github.com/YOUR_USERNAME/halal-maniacs.git
git push -u origin main
```

### Step 3: Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → Sign in with GitHub
2. Click **"Add New Project"**
3. Import your `halal-maniacs` repo
4. In **Environment Variables**, add:
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-your-key-here`
5. Click **Deploy**

Your app will be live at `https://halal-maniacs.vercel.app` (or your custom domain).

### Step 4 (Optional): Custom Domain
1. In Vercel → Project → Settings → Domains
2. Add your domain (e.g., `halalmaniacs.com`)
3. Update your DNS as instructed

## Run Locally

```bash
npm install
cp .env.example .env    # Add your API key
npm run dev              # Opens at http://localhost:3000
```

## Project Structure

```
halal-maniacs/
├── api/
│   └── search.js        # Vercel serverless proxy (hides API key)
├── public/
│   └── manifest.json    # PWA manifest
├── src/
│   ├── main.jsx         # Entry point
│   └── App.jsx          # Full app (search, DB, favorites, verify)
├── index.html
├── package.json
├── vite.config.js
├── vercel.json          # Routing config
└── .env.example
```

## Features

- 🔍 **AI Search** — 30-pass deep search across all platforms
- 📊 **Database** — 2,247 California restaurants pre-loaded
- ⭐ **Favorites** — Star restaurants to save them
- 📞 **AI Verification** — AI calls restaurants to check halal status
- 🧭 **Directions** — One-tap Google Maps navigation
- 🗑️ **Smart Dedup** — Fuzzy name + phone + address matching
- 🌙 **Dark Mode** — Auto light/dark theme
- 📱 **PWA** — Install as a native app on any phone

## API Costs

The app uses Claude Sonnet for searches. Typical costs:
- Each search pass: ~$0.01-0.03
- AI verification call: ~$0.01
- Full 30-pass deep search: ~$0.30-0.90

## Upgrading

To add more search sources (Perplexity, Google Places, Yelp API), edit `api/search.js` to proxy those APIs as well. No domain restrictions when self-hosted!
