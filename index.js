const express = require("express");
const crypto = require("crypto");

const app = express();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // ex: mystore.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN; // Admin API token
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // Webhook signing secret
const HOURS_LIMIT = parseInt(process.env.HOURS_LIMIT || "72");
const PORT = process.env.PORT || 3000;
// ────────────────────────────────────────────────────────────────────────────

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ── Verify Shopify webhook signature ────────────────────────────────────────
function verifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !WEBHOOK_SECRET) return false;
  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// ── Shopify API helper ───────────────────────────────────────────────────────
async function shopifyAPI(path, method = "GET", body = null) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/${path}`;
  const opts = {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ── Check for previous orders in last N hours ────────────────────────────────
async function findRecentOrders(phone, email, currentOrderId) {
  const since = new Date(Date.now() - HOURS_LIMIT * 60 * 60 * 1000).toISOString();
  const found = [];

  // Search by phone
  if (phone) {
    const cleaned = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
    const data = await shopifyAPI(
      `orders.json?status=any&created_at_min=${since}&fields=id,name,phone,email,created_at`
    );
    if (data.orders) {
      for (const o of data.orders) {
        if (String(o.id) === String(currentOrderId)) continue;
        const oPhone = (o.phone || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
        if (oPhone && oPhone === cleaned) found.push(o);
      }
    }
  }

  // Search by email (if not already found by phone)
  if (email && found.length === 0) {
    const data = await shopifyAPI(
      `orders.json?status=any&created_at_min=${since}&email=${encodeURIComponent(email)}&fields=id,name,phone,email,created_at`
    );
    if (data.orders) {
      for (const o of data.orders) {
        if (String(o.id) === String(currentOrderId)) continue;
        found.push(o);
      }
    }
  }

  return found;
}

// ── Cancel an order ──────────────────────────────────────────────────────────
async function cancelOrder(orderId, reason) {
  // Add a note first
  await shopifyAPI(`orders/${orderId}.json`, "PUT", {
    order: {
      id: orderId,
      note: reason,
    },
  });

  // Cancel the order
  await shopifyAPI(`orders/${orderId}/cancel.json`, "POST", {
    reason: "other",
    note: reason,
    email: false, // Don't send cancellation email (change to true if you want)
    restock: true,
  });

  console.log(`[${new Date().toISOString()}] Cancelled order ${orderId}: ${reason}`);
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────
app.post("/webhook/orders/create", async (req, res) => {
  // Verify it's really from Shopify
  if (!verifyWebhook(req)) {
    console.warn("Invalid webhook signature");
    return res.status(401).send("Unauthorized");
  }

  res.status(200).send("OK"); // Respond immediately to Shopify

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
      const reason = `Comandă duplicată anulată automat. Comandă anterioară în ultimele ${HOURS_LIMIT}h: ${dupNames}`;
      console.log(`Duplicate found for order ${orderName}: ${dupNames}`);
      await cancelOrder(orderId, reason);
    } else {
      console.log(`Order ${orderName} is unique. No action taken.`);
    }
  } catch (err) {
    console.error(`Error processing order ${orderName}:`, err);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "running",
    store: SHOPIFY_STORE,
    hours_limit: HOURS_LIMIT,
    message: `Blocking duplicate orders within ${HOURS_LIMIT} hours`,
  });
});

app.listen(PORT, () => {
  console.log(`Shopify Duplicate Order Blocker running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}`);
  console.log(`Blocking duplicates within: ${HOURS_LIMIT} hours`);
});
