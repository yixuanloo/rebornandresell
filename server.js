const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(cors());
app.use(express.json());

const SHOPIFY_STORE    = process.env.SHOPIFY_STORE;        // reborn-resell.myshopify.com
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;

// ─── Token cache ─────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getShopifyToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const url = `https://${SHOPIFY_STORE}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type:    'client_credentials'
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token error ${res.status}: ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // tokens expire after 24h; cache for 23h
  tokenExpiry = Date.now() + (data.expires_in ? data.expires_in * 1000 : 23 * 60 * 60 * 1000);
  return cachedToken;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Reborn & Resell Quiz API' }));

// ─── Main quiz endpoint ───────────────────────────────────────────────────────
app.post('/recommend', async (req, res) => {
  try {
    const { who, use, budget, brand } = req.body;
    const products = await fetchShopifyProducts(budget, brand);
    if (!products.length) {
      return res.status(404).json({ error: 'No products found matching criteria' });
    }
    const recommendations = await askClaude({ who, use, budget, brand }, products);
    res.json({ recommendations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong', detail: err.message });
  }
});

// ─── Fetch products from Shopify ──────────────────────────────────────────────
async function fetchShopifyProducts(budget, brands) {
  const token = await getShopifyToken();

  const params = new URLSearchParams({
    limit:  100,
    status: 'active',
    fields: 'id,title,vendor,tags,variants,images,body_html'
  });

  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?${params}`;
  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);
  const data = await response.json();
  let products = data.products || [];

  // Filter by budget range
  if (budget && budget.min !== undefined) {
    products = products.filter(p => {
      const prices = p.variants.map(v => parseFloat(v.price));
      const minPrice = Math.min(...prices);
      const maxBudget = budget.max >= 100000 ? Infinity : budget.max;
      return minPrice >= budget.min * 0.8 && minPrice <= maxBudget * 1.15;
    });
  }

  return products.map(p => ({
    id:          p.id,
    title:       p.title,
    brand:       p.vendor,
    price:       p.variants[0]?.price || '0',
    tags:        p.tags,
    image:       p.images[0]?.src || null,
    description: p.body_html?.replace(/<[^>]+>/g, '').slice(0, 200) || ''
  }));
}

// ─── Ask Claude to pick top 6 ─────────────────────────────────────────────────
async function askClaude(answers, products) {
  const { who, use, budget, brand } = answers;
  const budgetStr = budget
    ? `RM ${budget.min.toLocaleString()} – ${budget.max >= 100000 ? 'RM 100,000+' : 'RM ' + budget.max.toLocaleString()}`
    : 'any budget';
  const brandStr = brand && brand.length > 0 ? brand.join(', ') : 'no preference';
  const useMap = {
    everyday: 'everyday use',
    work:     'work and professional settings',
    occasion: 'special occasions and events',
    invest:   'collection and investment',
    travel:   'travel and jet-set lifestyle'
  };

  const prompt = `You are a luxury bag curator for Reborn & Resell, a pre-owned luxury marketplace in Malaysia.
A customer has completed our personalisation quiz with these answers:
- Buying for: ${who === 'self' ? 'themselves' : 'someone else'}
- Use case: ${useMap[use] || use}
- Budget: ${budgetStr}
- Preferred brands: ${brandStr}

Here are the available products in our inventory:
${JSON.stringify(products, null, 2)}

Please select the top 6 most suitable bags for this customer. Consider:
1. Budget fit (price within or close to their range)
2. Brand preference (prioritise preferred brands if available)
3. Use case suitability
4. Variety — try not to show 6 bags from the same brand
5. For aged/slow-moving stock (products with older tags), give a slight boost if still relevant

For each selected bag, provide a short personalised reason (1 sentence) explaining why it suits this customer.

Respond ONLY with a valid JSON array, no markdown, no explanation:
[
  {
    "id": "shopify_product_id",
    "title": "Bag name",
    "brand": "Brand name",
    "price": "price as number string",
    "image": "image url or null",
    "reason": "One sentence explaining why this suits the customer",
    "tag": "short label e.g. Best Match / Great Value / Staff Pick"
  }
]`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
  const data = await response.json();
  const text  = data.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── Keep server awake ────────────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + PORT;

setInterval(() => {
  fetch(SELF_URL + '/')
    .then(() => console.log('Keep-alive ping sent'))
    .catch(err => console.log('Keep-alive failed:', err.message));
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Quiz API running on port ${PORT}`));
