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

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d]/g, "").slice(-9);
}

async function shopifyAPIRaw(url) {
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
  });
  const json = await res.json();
  const linkHeader = res.headers.get("link") || "";
  return { json, linkHeader };
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

// Fetch ALL orders with pagination
async function fetchAllOrders(since) {
  const allOrders = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/2026-04/orders.json?status=any&created_at_min=${since}&limit=250&fields=id,name,phone,email,created_at,billing_address,cancelled_at,cancel_reason`;

  while (url) {
    const { json, linkHeader } = await shopifyAPIRaw(url);
    if (json.orders) allOrders.push(...json.orders);

    // Parse next page from Link header
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return allOrders;
}

async function findRecentOrders(phone, email, currentOrderId) {
  const since = new Date(Date.now() - HOURS_LIMIT * 60 * 60 * 1000).toISOString();
  const found = [];
  const cleanPhone = normalizePhone(phone);

  const orders = await fetchAllOrders(since);
  console.log(`Found ${orders.length} orders in last ${HOURS_LIMIT}h, looking for phone: ${cleanPhone}`);

  for (const o of orders) {
    if (String(o.id) === String(currentOrderId)) continue;
      if (o.cancel_reason || o.cancelled_at) continue; // ignora comenzile anulate

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

  return found;
}

async function cancelOrder(orderId, reason) {
  // Adauga nota
  await shopifyAPI(`orders/${orderId}.json`, "PUT", { order: { id: orderId, note: reason } });

  // Obtine detaliile comenzii pentru refund
  const orderData = await shopifyAPI(`orders/${orderId}.json`);
  const order = orderData?.order;

  // Anuleaza comanda cu restock
  await shopifyAPI(`orders/${orderId}/cancel.json`, "POST", { 
    reason: "other", 
    email: false, 
    restock: true
  });

  // Daca comanda are line items, face refund pentru a zeriza suma
  if (order?.line_items?.length > 0) {
    try {
      const refundLineItems = order.line_items.map(item => ({
        line_item_id: item.id,
        quantity: item.quantity,
        restock_type: "no_restock"
      }));
      const shipping = order.shipping_lines?.length > 0 ? {
        full_refund: true
      } : undefined;

      const refundPayload = {
        refund: {
          notify: false,
          note: reason,
          refund_line_items: refundLineItems,
          ...(shipping && { shipping })
        }
      };

      const refundResult = await shopifyAPI(`orders/${orderId}/refunds.json`, "POST", refundPayload);
      console.log(`Refund result:`, JSON.stringify(refundResult).substring(0, 300));
    } catch (refundErr) {
      console.log("Refund failed (non-critical):", refundErr.message);
    }
  }

  console.log(`Cancelled order ${orderId}`);
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

// ── Endpoint fix retroactiv - acceseaza o singura data din browser ────────────
app.get("/fix-cancelled-today", async (req, res) => {
  const secret = req.query.secret;
  if (secret !== "bunero2026fix") return res.status(401).send("Unauthorized");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.write("Incep zerorizarea comenzilor anulate de azi...\n\n");

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const since = today.toISOString();

    let url = `https://${SHOPIFY_STORE}/admin/api/2026-04/orders.json?status=cancelled&created_at_min=${since}&limit=250&fields=id,name,total_price,line_items,shipping_lines`;
    const allOrders = [];

    while (url) {
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
      const json = await r.json();
      if (json.orders) allOrders.push(...json.orders);
      const link = r.headers.get("link") || "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const toFix = allOrders.filter(o => parseFloat(o.total_price) > 0);
    res.write(`Gasit ${allOrders.length} comenzi anulate, ${toFix.length} cu suma > 0\n\n`);

    for (const order of toFix) {
      try {
        const refundLineItems = order.line_items
          .filter(item => item.quantity > 0)
          .map(item => ({ line_item_id: item.id, quantity: item.quantity, restock_type: "no_restock" }));

        if (refundLineItems.length === 0) {
          res.write(`- ${order.name}: deja 0, skip\n`);
          continue;
        }

        const refundPayload = {
          refund: {
            notify: false,
            note: "Zerorizare retroactiva",
            refund_line_items: refundLineItems,
            ...(order.shipping_lines?.length > 0 && { shipping: { full_refund: true } })
          }
        };

        const result = await shopifyAPI(`orders/${order.id}/refunds.json`, "POST", refundPayload);
        if (result.refund) {
          res.write(`✓ ${order.name} zerorizat (${order.total_price} lei)\n`);
        } else {
          res.write(`✗ ${order.name} eroare: ${JSON.stringify(result).substring(0, 100)}\n`);
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        res.write(`✗ ${order.name} eroare: ${err.message}\n`);
      }
    }

    res.write("\nGata!");
    res.end();
  } catch (err) {
    res.write("Eroare generala: " + err.message);
    res.end();
  }
});
