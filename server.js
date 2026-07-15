const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(cors());
app.use(express.json());

const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Reborn & Resell Quiz API' }));

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

async function fetchShopifyProducts(budget, brands) {
  const rawProducts = await getShopifyCatalog();
  let products = rawProducts;

  if (budget && budget.min !== undefined) {
    products = products.filter(p => {
      const prices = p.variants.map(v => parseFloat(v.price));
      const minPrice = Math.min(...prices);
      const maxBudget = budget.max >= 100000 ? Infinity : budget.max;
      return minPrice >= budget.min * 0.8 && minPrice <= maxBudget * 1.15;
    });
  }

  console.log(`Found ${products.length} products after budget filter`);

  return products.map(p => ({
    id:          p.id,
    title:       p.title,
    brand:       p.vendor,
    price:       p.variants[0]?.price || '0',
    tags:        p.tags,
    image:       p.images[0]?.src || null,
    url:         `https://${SHOPIFY_STORE}/products/${p.handle}`,
    description: p.body_html?.replace(/<[^>]+>/g, '').slice(0, 200) || ''
  }));
}

// ─── Cached Shopify catalog fetch with retry-on-429 ───────────────────────────
let catalogCache = { data: null, fetchedAt: 0 };
const CATALOG_CACHE_MS = 60 * 1000; // reuse the same catalog for 60s

async function getShopifyCatalog() {
  const now = Date.now();
  if (catalogCache.data && (now - catalogCache.fetchedAt) < CATALOG_CACHE_MS) {
    console.log('Using cached Shopify catalog');
    return catalogCache.data;
  }

  const url = `https://${SHOPIFY_STORE}/products.json?limit=250`;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url);

    if (response.status === 429) {
      const retryAfter = parseFloat(response.headers.get('retry-after')) || attempt * 1.5;
      console.warn(`Shopify rate limited (429). Retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
      if (attempt === maxRetries) {
        // Fall back to stale cache rather than fail the whole request, if we have one
        if (catalogCache.data) {
          console.warn('Serving stale cached catalog after repeated 429s');
          return catalogCache.data;
        }
        throw new Error(`Shopify fetch error: 429 (rate limited after ${maxRetries} attempts)`);
      }
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!response.ok) throw new Error(`Shopify fetch error: ${response.status}`);

    const data = await response.json();
    const products = data.products || [];
    catalogCache = { data: products, fetchedAt: now };
    return products;
  }
}

async function askClaude(answers, products) {
  const { who, use, budget, brand } = answers;
  const budgetStr = budget
    ? `RM ${budget.min.toLocaleString()} – ${budget.max >= 100000 ? 'RM 100,000+' : 'RM ' + budget.max.toLocaleString()}`
    : 'any budget';
  const brandStr = brand && brand.length > 0 ? brand.join(', ') : 'no preference';
  const useMap = {
    everyday:    'everyday use',
    work:        'work and professional settings',
    occasion:    'special occasions and events',
    invest:      'collection and investment',
    travel:      'travel and jet-set lifestyle',
    accessories: 'watches and accessories (not bags)'
  };

  const prompt = `You are a luxury goods curator for Reborn & Resell, a pre-owned luxury marketplace in Malaysia specialising in bags, watches, jewellery and accessories.
A customer has completed our personalisation quiz with these answers:
- Buying for: ${who === 'self' ? 'themselves' : 'someone else'}
- Looking for: ${useMap[use] || use}
- Budget: ${budgetStr}
- Preferred brands: ${brandStr}

Here are the available products in our inventory:
${JSON.stringify(products, null, 2)}

Please select the top 6 most suitable items for this customer. Consider:
1. Budget fit (price within or close to their range)
2. Brand preference (prioritise preferred brands if available)
3. Use case suitability — if they selected "watches and accessories", prioritise watches, jewellery and accessories over bags
4. Variety — try not to show 6 items from the same brand
5. For aged/slow-moving stock (products with older tags), give a slight boost if still relevant

For each selected item, provide a short personalised reason (1 sentence) explaining why it suits this customer.

Respond ONLY with a valid JSON array, no markdown, no explanation:
[
  {
    "id": "shopify_product_id",
    "title": "Item name",
    "brand": "Brand name",
    "price": "price as number string",
    "image": "image url or null",
    "url": "the exact url field from the matching product in the inventory above",
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

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + PORT;

setInterval(() => {
  fetch(SELF_URL + '/').then(() => console.log('Keep-alive ping sent')).catch(() => {});
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Quiz API running on port ${PORT}`));
