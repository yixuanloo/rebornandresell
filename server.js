const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(cors());
app.use(express.json());

const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ─── Product cache (5 minute TTL) ─────────────────────────────────────────────
let productCache = null;
let cacheExpiry = 0;

async function getProducts() {
  if (productCache && Date.now() < cacheExpiry) {
    console.log('Serving from cache, products:', productCache.length);
    return productCache;
  }
  console.log('Fetching fresh products from Shopify...');
  const url = `https://${SHOPIFY_STORE}/products.json?limit=250`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Shopify fetch error: ${response.status}`);
  const data = await response.json();
  productCache = data.products || [];
  cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
  console.log('Cached', productCache.length, 'products');
  return productCache;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Reborn & Resell Quiz API' }));

// ─── Main quiz endpoint ───────────────────────────────────────────────────────
app.post('/recommend', async (req, res) => {
  try {
    const { who, gender, use, budget, brand } = req.body;
    const allProducts = await getProducts();
    const products = filterProducts(allProducts, budget, brand);
    if (!products.length) {
      return res.status(404).json({ error: 'No products found matching criteria' });
    }
    const recommendations = await askClaude({ who, gender, use, budget, brand }, products);
    res.json({ recommendations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong', detail: err.message });
  }
});

// ─── Filter products by budget ────────────────────────────────────────────────
function filterProducts(products, budget, brands) {
  let filtered = products;

  if (budget && budget.min !== undefined) {
    filtered = filtered.filter(p => {
      const prices = p.variants.map(v => parseFloat(v.price));
      const minPrice = Math.min(...prices);
      const maxBudget = budget.max >= 100000 ? Infinity : budget.max;
      return minPrice >= budget.min * 0.8 && minPrice <= maxBudget * 1.15;
    });
  }

  console.log(`Found ${filtered.length} products after budget filter`);

  return filtered.map(p => ({
    id:          p.id,
    title:       p.title,
    brand:       p.vendor,
    price:       p.variants[0]?.price || '0',
    tags:        p.tags,
    collections: p.collections || [],
    image:       p.images[0]?.src || null,
    description: p.body_html?.replace(/<[^>]+>/g, '').slice(0, 300) || ''
  }));
}

// ─── Ask Claude to pick top 6 ─────────────────────────────────────────────────
async function askClaude(answers, products) {
  const { who, gender, use, budget, brand } = answers;
  const budgetStr = budget
    ? `RM ${budget.min.toLocaleString()} – ${budget.max >= 100000 ? 'RM 100,000+' : 'RM ' + budget.max.toLocaleString()}`
    : 'any budget';
  const brandStr = brand && brand.length > 0 ? brand.join(', ') : 'no preference';
  const useMap = {
    everyday: 'everyday use',
    work:     'work and professional settings',
    occasion: 'special occasions and events',
    invest:   'collection and investment',
    travel:   'travel'
  };

  const prompt = `You are a luxury bag curator for Reborn & Resell, a pre-owned luxury marketplace in Malaysia.
A customer has completed our personalisation quiz with these answers:
- Buying for: ${who === 'self' ? 'themselves' : 'someone else'}
- Gender: ${gender === 'female' ? 'Female' : gender === 'male' ? 'Male' : 'Not specified'}
- Use case: ${useMap[use] || use}
- Budget: ${budgetStr}
- Preferred brands: ${brandStr}

Here are the available products in our inventory:
${JSON.stringify(products, null, 2)}

Please select the top 6 most suitable bags for this customer. Consider:
1. Budget fit — closer to their stated budget scores higher; slightly under is safer than over
2. Gender appropriateness — match bag style to the gender specified
3. Brand preference — prioritise preferred brands if available
4. Use case suitability — match bag style to their intended use
5. Variety — try not to show 6 bags from the same brand
6. Description clues — use condition, material, style details from description

For the tag field, assign based on these rules:
- "Best Match" — strongest overall fit (budget + occasion + brand)
- "Great Value" — priced well under their max budget
- "Staff Pick" — editorial standout, interesting or rare piece
- "Investment Piece" — high-value, investment-grade bag

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
    "tag": "Best Match / Great Value / Staff Pick / Investment Piece"
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
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + PORT;

setInterval(() => {
  fetch(SELF_URL + '/').then(() => console.log('Keep-alive ping sent')).catch(() => {});
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Quiz API running on port ${PORT}`));
