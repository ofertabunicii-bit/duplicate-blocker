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
  let url = `https://${SHOPIFY_STORE}/admin/api/2026-04/orders.json?status=open&created_at_min=${since}&limit=250&fields=id,name,phone,email,created_at,billing_address,cancelled_at,cancel_reason,total_price,tags,fulfillment_status`;

  while (url) {
    const { json, linkHeader } = await shopifyAPIRaw(url);
    if (json.orders) allOrders.push(...json.orders);

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
  const orderTags = (order.tags || "").toLowerCase().split(",").map(t => t.trim());

  console.log(`[${new Date().toISOString()}] New order ${orderName} — phone: ${phone}, email: ${email}, tags: ${order.tags}`);

  // Delay 5 secunde ca sa fie sigur ca comanda e indexata in Shopify API
  await new Promise(r => setTimeout(r, 5000));

  // ── MODIFICARE 2: Dacă comanda e marcată manual ca duplicată de admin, o ignorăm ──
  if (orderTags.includes("duplicate") || orderTags.includes("duplicat") || orderTags.includes("duplicata")) {
    console.log(`Order ${orderName} has duplicate tag set manually — skipping.`);
    return;
  }

  try {
    const duplicates = await findRecentOrders(phone, email, orderId);

    if (duplicates.length > 0) {
      const dupNames = duplicates.map((o) => o.name).join(", ");

      // ── Verifică dacă există duplicate deja fulfillate (trimise la curier) ──
      const fulfilledDups = duplicates.filter(o => o.fulfillment_status === "fulfilled" || o.fulfillment_status === "partial");

      if (fulfilledDups.length > 0) {
        // Există o comandă anterioară deja trimisă la curier → anulăm întotdeauna noua comandă
        const fulfilledNames = fulfilledDups.map(o => o.name).join(", ");
        const reason = `Comanda duplicata anulata automat. Comanda anterioara deja expediata: ${fulfilledNames}`;
        console.log(`OLD order ${fulfilledNames} already fulfilled — cancelling NEW order ${orderName}`);
        await cancelOrder(orderId, reason);
      } else {
        // ── Nicio comandă anterioară nu e fulfillată → anulăm pe cea mai ieftină ──
        const currentValue = parseFloat(order.total_price || "0");

        // Găsește cea mai scumpă comandă anterioară
        const mostExpensiveDup = duplicates.reduce((max, o) => {
          const val = parseFloat(o.total_price || "0");
          return val > parseFloat(max.total_price || "0") ? o : max;
        }, duplicates[0]);

        const dupValue = parseFloat(mostExpensiveDup.total_price || "0");

        console.log(`DUPLICATE found for ${orderName} (${currentValue} lei) vs ${mostExpensiveDup.name} (${dupValue} lei)`);

        if (currentValue >= dupValue) {
          // Noua comandă e mai scumpă sau egală → anulăm comanda anterioară
          const reason = `Comanda duplicata anulata automat. Comanda noua mai valoroasa: ${orderName} (${currentValue} lei)`;
          console.log(`New order is >= in value — cancelling OLD order ${mostExpensiveDup.name}`);
          await cancelOrder(mostExpensiveDup.id, reason);

          // Dacă sunt mai multe duplicate, anulăm și pe celelalte
          for (const dup of duplicates) {
            if (String(dup.id) === String(mostExpensiveDup.id)) continue;
            const r2 = `Comanda duplicata anulata automat. Comanda noua mai valoroasa: ${orderName}`;
            await cancelOrder(dup.id, r2);
          }
        } else {
          // Noua comandă e mai ieftină → anulăm noua comandă
          const reason = `Comanda duplicata anulata automat. Comanda anterioara: ${dupNames}`;
          console.log(`New order is cheaper — cancelling NEW order ${orderName}`);
          await cancelOrder(orderId, reason);
        }
      }

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

// ── Cancel order fara zerorizare (pentru comenzi nelivrate) ──────────────────
async function cancelOrderOnly(orderId, reason) {
  await shopifyAPI(`orders/${orderId}.json`, "PUT", { order: { id: orderId, note: reason } });
  const result = await shopifyAPI(`orders/${orderId}/cancel.json`, "POST", { 
    reason: "other", 
    email: false, 
    restock: true
  });
  console.log(`Cancelled order ${orderId} (no refund):`, JSON.stringify(result).substring(0, 200));
}

// ── Webhook fulfillment update - anuleaza comenzile "not delivered" ───────────
app.post("/webhook/fulfillments/update", async (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");

  const fulfillment = req.body;
  const shipmentStatus = fulfillment.shipment_status;
  const orderId = fulfillment.order_id;
  const fulfillmentName = fulfillment.name || fulfillment.id;

  console.log(`[${new Date().toISOString()}] Fulfillment update: ${fulfillmentName}, shipment_status: ${shipmentStatus}, order_id: ${orderId}`);

  const notDeliveredStatuses = ["failure", "returned", "not_delivered"];

  if (notDeliveredStatuses.includes(shipmentStatus)) {
    console.log(`Order ${orderId} marked as ${shipmentStatus} - anulare automata...`);
    try {
      const reason = `Comanda anulata automat - colet nelivrat (status: ${shipmentStatus})`;
      await cancelOrderOnly(orderId, reason);
      console.log(`Order ${orderId} anulat cu succes.`);
    } catch (err) {
      console.error(`Eroare la anularea comenzii ${orderId}:`, err);
    }
  }
});

// ── Endpoint fix retroactiv not delivered 90 zile ────────────────────────────
app.get("/fix-not-delivered", async (req, res) => {
  const secret = req.query.secret;
  if (secret !== "bunero2026fix") return res.status(401).send("Unauthorized");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.write("Caut comenzi not delivered din ultimele 90 de zile...\n\n");

  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    let url = `https://${SHOPIFY_STORE}/admin/api/2026-04/orders.json?status=any&fulfillment_status=fulfilled&created_at_min=${since}&limit=250&fields=id,name,total_price,line_items,shipping_lines,fulfillments,cancelled_at`;
    const allOrders = [];

    while (url) {
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
      const json = await r.json();
      if (json.orders) allOrders.push(...json.orders);
      const link = r.headers.get("link") || "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const notDelivered = allOrders.filter(o => {
      if (o.cancelled_at) return false;
      return o.fulfillments?.some(f => 
        ["failure", "returned", "not_delivered"].includes(f.shipment_status)
      );
    });

    res.write(`Gasit ${allOrders.length} comenzi fulfillate, ${notDelivered.length} not delivered\n\n`);

    for (const order of notDelivered) {
      try {
        const reason = `Comanda anulata automat retroactiv - colet nelivrat`;
        await cancelOrderOnly(order.id, reason);
        res.write(`✓ ${order.name} anulat\n`);
      } catch (err) {
        res.write(`✗ ${order.name} eroare: ${err.message}\n`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    res.write("\nGata!");
    res.end();
  } catch (err) {
    res.write("Eroare generala: " + err.message);
    res.end();
  }
});
