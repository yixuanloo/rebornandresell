# Reborn & Resell — Quiz API

Backend server connecting the personalisation quiz to Shopify inventory and Claude AI.

## How it works

1. Quiz sends customer answers (who, use, budget, brands) to this server
2. Server fetches live products from Shopify filtered by budget
3. Claude picks the top 6 most suitable bags with personalised reasons
4. Server returns results to the quiz frontend

---

## Deploy to Railway (step by step)

### Step 1 — Push to GitHub
1. Go to github.com → click **New repository**
2. Name it `reborn-quiz-api` → click **Create repository**
3. Upload these files: `server.js`, `package.json`, `README.md`
   - Click **Add file** → **Upload files** → drag and drop both files → **Commit changes**

### Step 2 — Deploy on Railway
1. Go to railway.app → **New Project**
2. Click **Deploy from GitHub repo**
3. Select your `reborn-quiz-api` repository
4. Railway will auto-detect Node.js and start deploying

### Step 3 — Add environment variables
In Railway, click your project → **Variables** tab → add these one by one:

| Variable | Value |
|---|---|
| `SHOPIFY_STORE` | `rebornandresell.myshopify.com` |
| `SHOPIFY_TOKEN` | Your `shpat_...` token |
| `CLAUDE_API_KEY` | Your `sk-ant-...` key |

Click **Deploy** after adding variables.

### Step 4 — Get your server URL
Railway gives you a public URL like:
`https://reborn-quiz-api-production.up.railway.app`

Copy this — you'll need it for the quiz HTML file.

### Step 5 — Update the quiz HTML
In your `reborn-edit-quiz.html`, find the `runReveal()` function and replace the line that uses the local `CATALOG` with a fetch call to your Railway URL:

```javascript
const response = await fetch('https://your-railway-url.up.railway.app/recommend', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    who: answers.who,
    use: answers.use,
    budget: answers.budget,
    brand: answers.brand
  })
});
const { recommendations } = await response.json();
// recommendations is an array of 6 bags — use this instead of CATALOG
```

---

## Test it locally (optional)

```bash
npm install
SHOPIFY_STORE=rebornandresell.myshopify.com \
SHOPIFY_TOKEN=shpat_xxx \
CLAUDE_API_KEY=sk-ant-xxx \
node server.js
```

Then test with:
```bash
curl -X POST http://localhost:3000/recommend \
  -H "Content-Type: application/json" \
  -d '{"who":"self","use":"everyday","budget":{"min":5000,"max":20000},"brand":["chanel","lv"]}'
```

---

## Cost estimate
- Railway hosting: ~USD 5/month
- Claude API: ~USD 0.01–0.03 per quiz completion
- Shopify API: free with your existing plan
