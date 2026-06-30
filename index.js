const express = require("express");
const crypto = require("crypto");

const app = express();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
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

// ── Shopify GraphQL helper ───────────────────────────────────────────────────
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// ── Check for previous orders in last N hours ────────────────────────────────
async function findRecentOrders(phone, email, currentOrderId) {
  const since = new Date(Date.now() - HOURS_LIMIT * 60 * 60 * 1000).toISOString();
  const found = [];

  const cleanPhone = phone ? phone.replace(/\s+/g, "").replace(/[^\d+]/g, "") : "";

  let queryStr = `created_at:>='${since}'`;
  if (cleanPhone) queryStr += ` phone:${cleanPhone}`;
  else if (email) queryStr += ` email:${email}`;

  const gql = `
    query($q: String!) {
      orders(first: 20, query: $q) {
        edges {
          node {
            id
            name
            phone
            email
            createdAt
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(gql, { q: queryStr });
  console.log("GraphQL response:", JSON.stringify(data).substring(0, 500));

  if (data?.data?.orders?.edges) {
    for (const { node } of data.data.orders.edges) {
      const nodeId = node.id.split("/").pop();
      if (String(nodeId) === String(currentOrderId)) continue;

      if (cleanPhone) {
        const oPhone = (node.phone || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
        if (oPhone && oPhone === cleanPhone) found.push(node);
      } else if (email && node.email === email) {
        found.push(node);
      }
    }
  }

  return found;
}

// ── Cancel an order ──────────────────────────────────────────────────────────
async function cancelOrder(orderId, reason) {
  const gql = `
    mutation cancelOrder($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!, $refund: Boolean!, $restock: Boolean!) {
      orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer, refund: $refund, restock: $restock) {
        job {
          id
        }
        orderCancelUserErrors {
          message
        }
      }
    }
  `;

  const gid = `gid://shopify/Order/${orderId}`;
  const result = await shopifyGraphQL(gql, {
    orderId: gid,
    reason: "OTHER",
    notifyCustomer: false,
    refund: false,
    restock: true,
  });

  console.log("Cancel result:", JSON.stringify(result).substring(0, 300));
  console.log(`[${new Date().toISOString()}] Cancelled order ${orderId}: ${reason}`);
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────
app.post("/webhook/orders/create", async (req, res) => {
  if (!verifyWebhook(req)) {
    console.warn("Invalid webhook signature");
    return res.status(401).send("Unauthorized");
  }

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
      const reason = `Comanda duplicata anulata automat. Comanda anterioara in ultimele ${HOURS_LIMIT}h: ${dupNames}`;
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
