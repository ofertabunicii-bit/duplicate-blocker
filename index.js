const express = require("express");
const crypto = require("crypto");

const app = express();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const HOURS_LIMIT = parseInt(process.env.HOURS_LIMIT || "72");
const PORT = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/auth/callback", async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) return res.send("Missing code or shop");
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code }),
    });
    const data = await response.json();
    console.log("=== ACCESS TOKEN OBTINUT ===");
    console.log("access_token:", data.access_token);
    console.log("============================");
    res.send(`<h1>Token obtinut!</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
  } catch (err) {
    res.send("Eroare: " + err.message);
  }
});

function verifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !WEBHOOK_SECRET) return false;
  const digest = crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// Normalizeaza numarul de telefon - pastreaza doar ultimele 9 cifre
function normalizePhone(phone) {
  if (!phone) return "";
  const digits = phone.replace(/[^\d]/g, "");
  // Pastreaza ultimele 9 cifre pentru comparatie (evita probleme cu prefixe)
  return digits.slice(-9);
}

async function shopifyAPI(path, method = "GET", body = null) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/${path}`;
  const opts = {
    method,
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

async function findRecentOrders(phone, email, currentOrderId) {
  const since = new Date(Date.now() - HOURS_LIMIT * 60 * 60 * 1000).toISOString();
  const found = [];
  const cleanPhone = normalizePhone(phone);

  const data = await shopifyAPI(`orders.json?status=any&created_at_min=${since}&limit=250&fields=id,name,phone,email,created_at,billing_address`);
  
  if (data.orders) {
    console.log(`Found ${data.orders.length} orders in last ${HOURS_LIMIT}h, looking for phone: ${cleanPhone}`);
    for (const o of data.orders) {
      if (String(o.id) === String(currentOrderId)) continue;
      
      const oPhone = normalizePhone(o.phone || o.billing_address?.phone || "");
      
      if (cleanPhone && oPhone && oPhone === cleanPhone) {
        console.log(`MATCH: ${o.name} has same phone (${oPhone})`);
        found.push(o);
        continue;
      }
      if (email && o.email && o.email.toLowerCase() === email.toLowerCase()) {
        console.log(`MATCH: ${o.name} has same email`);
        found.push(o);
      }
    }
  } else {
    console.log("API error:", JSON.stringify(data).substring(0, 300));
  }

  return found;
}

async function cancelOrder(orderId, reason) {
  await shopifyAPI(`orders/${orderId}.json`, "PUT", { order: { id: orderId, note: reason } });
  const result = await shopifyAPI(`orders/${orderId}/cancel.json`, "POST", { reason: "other", email: false, restock: true });
  console.log(`Cancelled order ${orderId}:`, JSON.stringify(result).substring(0, 200));
}

app.post("/webhook/orders/create", async (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");

  const order = req.body;
  const orderId = order.id;
  const orderName = order.name;
  const phone = order.billing_address?.phone || order.phone || "";
  const email = order.email || "";

  console.log(`[${new Date().toISOString()}] New order ${orderName} — phone: ${phone}, email: ${email}`);

  try {
    const duplicates = await findRecentOrders(phone, email, orderId);
    if (duplicates.length > 0) {
      const dupNames = duplicates.map((o) => o.name).join(", ");
      const reason = `Comanda duplicata anulata automat. Comanda anterioara: ${dupNames}`;
      console.log(`DUPLICATE found for ${orderName}: ${dupNames}`);
      await cancelOrder(orderId, reason);
    } else {
      console.log(`Order ${orderName} is unique. No action taken.`);
    }
  } catch (err) {
    console.error(`Error:`, err);
  }
});

app.get("/", (req, res) => res.json({ status: "running", store: SHOPIFY_STORE, hours_limit: HOURS_LIMIT }));

app.listen(PORT, () => {
  console.log(`Shopify Duplicate Order Blocker running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}`);
  console.log(`Blocking duplicates within: ${HOURS_LIMIT} hours`);
});
