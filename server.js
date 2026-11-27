const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { serverLogger, clientLogger } = require('./logger');
const { sendActivationEmail, sendOrderReceivedEmail, sendOrderReminderEmail } = require('./mailer');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 5000;
const RESTAURANT_WHATSAPP = '917200451980';
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const DATA_DIR = IS_VERCEL ? '/tmp/homefood-data' : __dirname;
if (IS_VERCEL && !fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    // Ignore if already exists
  }
}
const DB_FILE = path.join(DATA_DIR, 'orders.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const GARBAGE_FILE = path.join(DATA_DIR, 'garbage.json');
const ENV_FILE = path.join(__dirname, '.env');

function loadEnvConfig() {
  const config = {
    ...process.env,
    ALLOWED_MANAGE_IPS: process.env.ALLOWED_MANAGE_IPS || '192.168.24.42',
    MANAGE_SECRET_CODE: process.env.MANAGE_SECRET_CODE || '0000'
  };
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        config[key] = val;
      }
    }
  }
  return config;
}

function getAllowedIps() {
  const cfg = loadEnvConfig();
  return cfg.ALLOWED_MANAGE_IPS.split(',')
    .map((ip) => ip.trim().replace(/^::ffff:/i, ''))
    .filter(Boolean);
}

function getManageSecretCode() {
  const cfg = loadEnvConfig();
  return cfg.MANAGE_SECRET_CODE || '0000';
}

function getMenuPrices() {
  const cfg = loadEnvConfig();
  return {
    PRICE_ONLY_LUNCH: Number(cfg.PRICE_ONLY_LUNCH || 120),
    PRICE_ONLY_LUNCH_NON_VEG: Number(cfg.PRICE_ONLY_LUNCH_NON_VEG || 150),
    PRICE_ONLY_DINNER: Number(cfg.PRICE_ONLY_DINNER || 100),
    PRICE_ONLY_TIFFEN: Number(cfg.PRICE_ONLY_TIFFEN || 80),
    PRICE_WEEKEND_COMBO: Number(cfg.PRICE_WEEKEND_COMBO || 250),
    PRICE_MONTHLY_VEG: Number(cfg.PRICE_MONTHLY_VEG || 189),
    PRICE_MONTHLY_NON_VEG: Number(cfg.PRICE_MONTHLY_NON_VEG || 200)
  };
}

function getGstPercent() {
  const cfg = loadEnvConfig();
  const parsed = Number(cfg.GST_PERCENT);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
}

function getSmtpConfig() {
  const cfg = loadEnvConfig();
  return {
    SMTP_HOST: cfg.SMTP_HOST || process.env.SMTP_HOST || '',
    SMTP_PORT: cfg.SMTP_PORT || process.env.SMTP_PORT || '587',
    SMTP_SECURE: cfg.SMTP_SECURE || process.env.SMTP_SECURE || 'false',
    SMTP_USER: cfg.SMTP_USER || process.env.SMTP_USER || '',
    SMTP_PASS: cfg.SMTP_PASS || process.env.SMTP_PASS || '',
    SMTP_FROM_NAME: cfg.SMTP_FROM_NAME || process.env.SMTP_FROM_NAME || 'Sri Lakshmi HomeFood'
  };
}

function resolvePlanPrice(packageName, prices) {
  const p = (packageName || '').toLowerCase();
  const isNonVeg = p.includes('non-veg') || p.includes('non veg') || p.includes('nonveg');
  if (p.includes('monthly')) {
    return isNonVeg ? prices.PRICE_MONTHLY_NON_VEG : prices.PRICE_MONTHLY_VEG;
  }
  if (p.includes('weekend')) return prices.PRICE_WEEKEND_COMBO;
  if (p.includes('tiffen') || p.includes('tiffin') || p.includes('breakfast')) return prices.PRICE_ONLY_TIFFEN;
  if (p.includes('dinner')) return prices.PRICE_ONLY_DINNER;
  if (p.includes('lunch')) {
    return isNonVeg ? prices.PRICE_ONLY_LUNCH_NON_VEG : prices.PRICE_ONLY_LUNCH;
  }
  return prices.PRICE_ONLY_LUNCH;
}

function buildCustomerBillObject(customer) {
  const prices = getMenuPrices();
  const unitPrice = resolvePlanPrice(customer.packageName, prices);

  let validityDays = 1;
  if (customer.startDate && customer.endDate) {
    const s = new Date(customer.startDate + 'T00:00:00Z');
    const e = new Date(customer.endDate + 'T00:00:00Z');
    if (Number.isFinite(s.getTime()) && Number.isFinite(e.getTime())) {
      const diff = Math.round(Math.abs(e - s) / (1000 * 60 * 60 * 24));
      validityDays = diff > 0 ? diff : 1;
    }
  }

  const planTotal = Number((unitPrice * validityDays).toFixed(2));
  const customItems = Array.isArray(customer.customItems)
    ? customer.customItems
      .filter((ci) => ci && String(ci.name || '').trim() && Number.isFinite(Number(ci.amount)))
      .map((ci) => ({
        name: String(ci.name).trim(),
        amount: Number(Number(ci.amount).toFixed(2))
      }))
    : [];
  const customTotal = Number(customItems.reduce((sum, ci) => sum + ci.amount, 0).toFixed(2));
  const subtotal = Number((planTotal + customTotal).toFixed(2));
  const gstPercent = getGstPercent();
  const gstAmount = Number(((subtotal * gstPercent) / 100).toFixed(2));
  const cgstAmount = Number((gstAmount / 2).toFixed(2));
  const sgstAmount = Number((gstAmount - cgstAmount).toFixed(2));
  const grandTotal = Number((subtotal + gstAmount).toFixed(2));
  const now = new Date();

  return {
    billNo: `SLF-${customer.customerId.replace('CUST-', '')}`,
    date: now.toLocaleDateString('en-IN'),
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    customerId: customer.customerId,
    orderId: customer.orderId,
    customerName: customer.custName,
    phone: customer.custWhatsApp,
    email: customer.custEmail || '',
    planName: customer.packageName,
    startDate: customer.startDate,
    endDate: customer.endDate,
    validityDays,
    timeSlot: customer.deliveryTimeSlot,
    deliveryArea: customer.deliveryArea,
    address: customer.fullAddress,
    specialNotes: customer.specialNotes || '',
    unitPrice,
    planTotal,
    customItems,
    customTotal,
    subtotal,
    gstPercent,
    gstAmount,
    cgstAmount,
    sgstAmount,
    grandTotal,
    fssai: '22423567000189'
  };
}

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  const vercelIp = req.headers['x-vercel-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp =
    (cfIp && String(cfIp).split(',')[0].trim()) ||
    (vercelIp && String(vercelIp).split(',')[0].trim()) ||
    (realIp && String(realIp).split(',')[0].trim()) ||
    (forwarded && String(forwarded).split(',')[0].trim()) ||
    req.socket.remoteAddress ||
    req.ip ||
    '';
  return rawIp.replace(/^::ffff:/i, '').trim();
}

function isIpMatch(clientIp, pattern) {
  if (!clientIp || !pattern) return false;
  if (pattern === '*') return true;
  if (pattern === clientIp) return true;
  if (pattern.includes('*')) {
    const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr).test(clientIp);
  }
  return false;
}

function requireAllowedIp(req, res, next) {
  const clientIp = getClientIp(req);
  const allowedIps = getAllowedIps();
  const matched = allowedIps.some((pattern) => isIpMatch(clientIp, pattern));
  if (!matched) {
    serverLogger.write('WARN', 'MANAGE_ACCESS_DENIED', { clientIp, path: req.originalUrl });
    return res.status(403).json({
      allowed: false,
      clientIp,
      error: 'Access denied. This management route is restricted to authorized IP addresses.'
    });
  }
  next();
}

function requireManageCode(req, res, next) {
  const code = (req.body && req.body.code) || req.headers['x-manage-code'] || '';
  if (String(code).trim() !== getManageSecretCode()) {
    serverLogger.write('WARN', 'MANAGE_INVALID_CODE', { clientIp: getClientIp(req), path: req.originalUrl });
    return res.status(401).json({ valid: false, error: 'Invalid secret code.' });
  }
  next();
}

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Trace every backend HTTP operation into C:\homefood\server
app.use((req, res, next) => {
  if (req.path === '/api/logs/client') return next();
  const start = Date.now();
  res.on('finish', () => {
    serverLogger.write('INFO', 'HTTP_REQUEST', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip: getClientIp(req)
    });
  });
  next();
});

// Initialize persistent DB files if not exists (seed /tmp from repo JSON on Vercel)
function ensureDbFile(targetPath, seedName) {
  if (!fs.existsSync(targetPath)) {
    const seedPath = path.join(__dirname, seedName);
    if (IS_VERCEL && fs.existsSync(seedPath)) {
      fs.copyFileSync(seedPath, targetPath);
    } else {
      fs.writeFileSync(targetPath, JSON.stringify([]));
    }
  }
}
ensureDbFile(DB_FILE, 'orders.json');
ensureDbFile(CUSTOMERS_FILE, 'customers.json');
ensureDbFile(GARBAGE_FILE, 'garbage.json');

function normalizePhone10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function dedupeByPhoneAndEmail(rows, getPhoneFn, getEmailFn) {
  const seenPhones = new Set();
  const seenEmails = new Set();
  const result = [];
  for (const row of rows) {
    const p = normalizePhone10(getPhoneFn(row));
    const em = normalizeEmail(getEmailFn(row));
    if (p && seenPhones.has(p)) continue;
    if (em && seenEmails.has(em)) continue;
    if (p) seenPhones.add(p);
    if (em) seenEmails.add(em);
    result.push(row);
  }
  return result;
}

function dedupeAllLists() {
  const customers = dedupeByPhoneAndEmail(readJsonDB(CUSTOMERS_FILE), (c) => c.custWhatsApp, (c) => c.custEmail);
  const customerPhones = new Set(customers.map((c) => normalizePhone10(c.custWhatsApp)).filter(Boolean));
  const customerEmails = new Set(customers.map((c) => normalizeEmail(c.custEmail)).filter(Boolean));

  const orders = dedupeByPhoneAndEmail(readJsonDB(DB_FILE), (o) => o.custWhatsApp, (o) => o.custEmail);
  const orderPhones = new Set(orders.map((o) => normalizePhone10(o.custWhatsApp)).filter(Boolean));
  const orderEmails = new Set(orders.map((o) => normalizeEmail(o.custEmail)).filter(Boolean));

  const rawGarbage = dedupeByPhoneAndEmail(
    readJsonDB(GARBAGE_FILE),
    (g) => g?.item?.custWhatsApp,
    (g) => g?.item?.custEmail
  );
  const garbage = rawGarbage.filter((g) => {
    const p = normalizePhone10(g?.item?.custWhatsApp);
    const em = normalizeEmail(g?.item?.custEmail);
    if (p && (customerPhones.has(p) || orderPhones.has(p))) return false;
    if (em && (customerEmails.has(em) || orderEmails.has(em))) return false;
    return true;
  });

  writeJsonDB(CUSTOMERS_FILE, customers);
  writeJsonDB(DB_FILE, orders);
  writeJsonDB(GARBAGE_FILE, garbage);
}

dedupeAllLists();

function readJsonDB(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    return [];
  }
}

function writeJsonDB(filePath, rows) {
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
  return rows;
}

function getOrdersFromDB() {
  return readJsonDB(DB_FILE);
}

function saveOrderToDB(newOrder) {
  const phone = normalizePhone10(newOrder.custWhatsApp);
  const email = normalizeEmail(newOrder.custEmail);
  const currentOrders = getOrdersFromDB().filter((o) => {
    if (phone && normalizePhone10(o.custWhatsApp) === phone) return false;
    if (email && normalizeEmail(o.custEmail) === email) return false;
    return true;
  });
  currentOrders.unshift(newOrder); // newest first
  return writeJsonDB(DB_FILE, currentOrders);
}

function archiveToGarbage(type, target) {
  const phone = normalizePhone10(target?.custWhatsApp);
  const email = normalizeEmail(target?.custEmail);
  const refId = target?.customerId || target?.orderId || '';
  const garbage = readJsonDB(GARBAGE_FILE).filter((g) => {
    const gPhone = normalizePhone10(g?.item?.custWhatsApp);
    const gEmail = normalizeEmail(g?.item?.custEmail);
    const gRefId = g?.item?.customerId || g?.item?.orderId || '';
    if (phone && gPhone === phone) return false;
    if (email && gEmail === email) return false;
    if (refId && gRefId === refId) return false;
    return true;
  });
  garbage.unshift({
    garbageId: `GRB-${Date.now().toString().slice(-6)}`,
    type,
    deletedAt: new Date().toISOString(),
    item: target
  });
  return writeJsonDB(GARBAGE_FILE, garbage);
}

function removePhoneFromGarbage(phone, email = '') {
  const p = normalizePhone10(phone);
  const em = normalizeEmail(email);
  const garbage = readJsonDB(GARBAGE_FILE);
  if (!p && !em) return garbage;
  const filtered = garbage.filter((g) => {
    const gPhone = normalizePhone10(g?.item?.custWhatsApp);
    const gEmail = normalizeEmail(g?.item?.custEmail);
    if (p && gPhone === p) return false;
    if (em && gEmail === em) return false;
    return true;
  });
  if (filtered.length !== garbage.length) {
    writeJsonDB(GARBAGE_FILE, filtered);
  }
  return filtered;
}

function findDuplicateInCustomers(customers, phone, email = '', excludeCustomerId = null) {
  const p = normalizePhone10(phone);
  const em = normalizeEmail(email);
  for (const c of customers) {
    if (excludeCustomerId && c.customerId === excludeCustomerId) continue;
    if (p && normalizePhone10(c.custWhatsApp) === p) return { field: 'number', value: phone, record: c };
    if (em && normalizeEmail(c.custEmail) === em) return { field: 'email', value: email, record: c };
  }
  return null;
}

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Sri Lakshmi HomeFood Backend API',
    whatsapp: RESTAURANT_WHATSAPP,
    db: 'Connected (orders.json)'
  });
});

// Create Order -> Settles in Database, Sends Acknowledgement Email & Returns direct WhatsApp Bot link
app.post('/api/orders', async (req, res) => {
  try {
    const {
      custName,
      custWhatsApp,
      custEmail = '',
      packageName,
      deliveryArea,
      deliveryTimeSlot,
      fullAddress,
      deliveryDate,
      specialNotes = '',
      planType = 'Daily Plan'
    } = req.body;

    if (!custName || !custWhatsApp) {
      return res.status(400).json({ error: 'Customer Name and WhatsApp Number are required.' });
    }

    const orderId = `SLHF-${Date.now().toString().slice(-6)}`;
    const timestamp = new Date().toISOString();

    const orderRecord = {
      orderId,
      custName,
      custWhatsApp,
      custEmail: String(custEmail || '').trim(),
      packageName: packageName || 'Homestyle Food Plan',
      planType,
      deliveryArea: deliveryArea || 'Guduvancherry',
      deliveryTimeSlot: deliveryTimeSlot || 'Afternoon Lunch',
      fullAddress: fullAddress || 'Address will be provided on chat',
      deliveryDate: deliveryDate || 'Earliest available',
      specialNotes,
      status: 'New Order Received',
      createdAt: timestamp
    };

    // Settle directly into persistent database file
    saveOrderToDB(orderRecord);
    console.log(`[DB SUCCESS] Order settled in database: ${orderId} from ${custName} (${custWhatsApp})`);

    // Clean formatted message for WhatsApp (No pricing details, no colored emojis)
    const waBotMessage =
      `*NEW ORDER - Sri Lakshmi Home Food*
Order Ref: ${orderId}
--------------------------------
Name: ${custName}
Phone: ${custWhatsApp}
Plan: ${orderRecord.packageName}
Date: ${orderRecord.deliveryDate}
Time Slot: ${orderRecord.deliveryTimeSlot}
Delivery Area: ${orderRecord.deliveryArea}
Address: ${orderRecord.fullAddress}${specialNotes ? `\nNotes: ${specialNotes}` : ''}
--------------------------------
Please confirm my homestyle delivery schedule.`;

    const whatsappUrl = `https://wa.me/${RESTAURANT_WHATSAPP}?text=${encodeURIComponent(waBotMessage)}`;

    let emailStatus = { sent: false, reason: 'Not attempted' };
    try {
      emailStatus = await sendOrderReceivedEmail({
        order: orderRecord,
        smtpConfig: getSmtpConfig(),
        contactPhone: '7200451980'
      });
      serverLogger.write(emailStatus.sent ? 'INFO' : 'WARN', 'ORDER_ACK_EMAIL', {
        orderId: orderRecord.orderId,
        email: orderRecord.custEmail,
        emailStatus
      });
    } catch (mailErr) {
      emailStatus = { sent: false, reason: mailErr.message };
      serverLogger.write('ERROR', 'ORDER_ACK_EMAIL_FAILED', {
        orderId: orderRecord.orderId,
        email: orderRecord.custEmail,
        error: mailErr.message
      });
    }

    res.status(201).json({
      success: true,
      message: 'Order successfully settled in database and WhatsApp bot triggered',
      order: orderRecord,
      whatsappUrl,
      emailStatus
    });
  } catch (err) {
    console.error('Error saving order:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve static frontend / root files with cache optimization for assets
app.use('/assets', express.static(path.join(__dirname, '..', 'assets'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..'), { maxAge: '1h' }));

// View all database orders
app.get('/api/orders', (req, res) => {
  const orders = getOrdersFromDB();
  res.json({ total: orders.length, orders });
});

// ==================== MANAGEMENT ROUTES (/manage) ====================

// Diagnostic IP check endpoint
app.get('/api/check-ip', (req, res) => {
  res.json({
    resolvedClientIp: getClientIp(req),
    remoteAddr: (req.socket.remoteAddress || '').replace(/^::ffff:/i, ''),
    forwardedFor: req.headers['x-forwarded-for'] || null,
    realIp: req.headers['x-real-ip'] || null
  });
});

// Check IP access for /manage
app.get('/api/manage/access', requireAllowedIp, (req, res) => {
  res.json({ allowed: true, clientIp: getClientIp(req) });
});

// Verify secret code (0000)
app.post('/api/manage/verify', requireAllowedIp, requireManageCode, (req, res) => {
  res.json({ valid: true });
});

function enrichOrdersWithEstimate(orders) {
  const prices = getMenuPrices();
  const gstPercent = getGstPercent();
  const defaultDays = 30;
  return orders.map((ord) => {
    const estimatedUnitPrice = resolvePlanPrice(ord.packageName, prices);
    const estimatedPlanTotal = Number((estimatedUnitPrice * defaultDays).toFixed(2));
    const estimatedGstAmount = Number(((estimatedPlanTotal * gstPercent) / 100).toFixed(2));
    const estimatedGrandTotal = Number((estimatedPlanTotal + estimatedGstAmount).toFixed(2));
    return {
      ...ord,
      estimatedDays: defaultDays,
      estimatedUnitPrice,
      estimatedPlanTotal,
      estimatedGstPercent: gstPercent,
      estimatedGrandTotal
    };
  });
}

// List all orders (requires IP + secret code) with 30-day estimated bill amount
app.get('/api/manage/orders', requireAllowedIp, requireManageCode, (req, res) => {
  const orders = enrichOrdersWithEstimate(getOrdersFromDB());
  res.json({ total: orders.length, orders });
});

// Direct Add Order from /manage Orders page (from Garbage lookup or Manual entry)
app.post('/api/manage/orders/direct', requireAllowedIp, requireManageCode, async (req, res) => {
  const {
    custName,
    custWhatsApp,
    custEmail = '',
    packageName = 'Only Lunch - Pure Veg',
    deliveryArea = 'Guduvancherry',
    deliveryTimeSlot = 'Afternoon Lunch (12:00 PM - 1:00 PM)',
    fullAddress = 'Address will be provided',
    startDate,
    specialNotes = ''
  } = req.body || {};

  if (!custName || !String(custName).trim() || !custWhatsApp || !String(custWhatsApp).trim()) {
    return res.status(400).json({ error: 'Customer Name and Phone Number are required.' });
  }

  const customers = readJsonDB(CUSTOMERS_FILE);
  const dupCust = findDuplicateInCustomers(customers, custWhatsApp, custEmail);
  if (dupCust) {
    return res.status(409).json({
      error: `This ${dupCust.field} (${dupCust.value}) already exists in Customers (${dupCust.record.custName}). You can only add if the customer is in Garbage.`
    });
  }

  const existingOrders = getOrdersFromDB();
  const phone10 = normalizePhone10(custWhatsApp);
  const emailNorm = normalizeEmail(custEmail);
  const existingOrder = existingOrders.find(
    (o) => (phone10 && normalizePhone10(o.custWhatsApp) === phone10) || (emailNorm && normalizeEmail(o.custEmail) === emailNorm)
  );
  if (existingOrder) {
    return res.status(409).json({
      error: `This phone or email already exists in Orders (${existingOrder.custName}).`
    });
  }

  const orderId = `SLHF-${Date.now().toString().slice(-6)}`;
  const orderRecord = {
    orderId,
    custName: String(custName).trim(),
    custWhatsApp: String(custWhatsApp).trim(),
    custEmail: String(custEmail || '').trim(),
    packageName: String(packageName || 'Only Lunch - Pure Veg').trim(),
    planType: 'Daily Plan',
    deliveryArea: String(deliveryArea || 'Guduvancherry').trim(),
    deliveryTimeSlot: String(deliveryTimeSlot || 'Afternoon Lunch (12:00 PM - 1:00 PM)').trim(),
    fullAddress: String(fullAddress || 'Address will be provided').trim(),
    deliveryDate: String(startDate || new Date().toISOString().split('T')[0]).trim(),
    specialNotes: String(specialNotes || '').trim(),
    status: 'New Order Received',
    createdAt: new Date().toISOString()
  };

  const savedOrders = saveOrderToDB(orderRecord);
  const garbage = removePhoneFromGarbage(orderRecord.custWhatsApp, orderRecord.custEmail);

  let emailStatus = { sent: false, reason: 'Not attempted' };
  try {
    emailStatus = await sendOrderReceivedEmail({
      order: orderRecord,
      smtpConfig: getSmtpConfig(),
      contactPhone: '7200451980'
    });
  } catch (mailErr) {
    emailStatus = { sent: false, reason: mailErr.message };
  }

  res.status(201).json({
    success: true,
    order: orderRecord,
    orders: enrichOrdersWithEstimate(savedOrders),
    garbage,
    emailStatus
  });
});

// Preview Bill for Direct Add Customer before payment confirmation
app.post('/api/manage/customers/preview-bill', requireAllowedIp, requireManageCode, (req, res) => {
  const {
    custName = 'Customer',
    custWhatsApp = '',
    custEmail = '',
    packageName = 'Only Lunch - Pure Veg',
    deliveryArea = 'Guduvancherry',
    deliveryTimeSlot = 'Afternoon Lunch (12:00 PM - 1:00 PM)',
    fullAddress = '',
    startDate,
    endDate,
    specialNotes = '',
    customItems = []
  } = req.body || {};

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Start Date and End Date are required to preview bill.' });
  }

  const normalizedCustomItems = Array.isArray(customItems)
    ? customItems
        .filter((ci) => ci && String(ci.name || '').trim() && Number.isFinite(Number(ci.amount)) && Number(ci.amount) >= 0)
        .map((ci) => ({
          name: String(ci.name).trim(),
          amount: Number(Number(ci.amount).toFixed(2))
        }))
    : [];

  const bill = buildCustomerBillObject({
    customerId: 'CUST-PREVIEW',
    orderId: 'MANUAL-PREVIEW',
    custName,
    custWhatsApp,
    custEmail,
    packageName,
    deliveryArea,
    deliveryTimeSlot,
    fullAddress,
    startDate,
    endDate,
    specialNotes,
    customItems: normalizedCustomItems
  });
  res.json({ bill });
});

// Remove an order and archive to garbage list (requires IP + secret code)
app.delete('/api/manage/orders/:orderId', requireAllowedIp, requireManageCode, (req, res) => {
  const { orderId } = req.params;
  const orders = getOrdersFromDB();
  const target = orders.find((o) => o.orderId === orderId);
  if (!target) {
    return res.status(404).json({ error: 'Order not found.' });
  }
  const filtered = orders.filter((o) => o.orderId !== orderId);
  writeJsonDB(DB_FILE, filtered);

  const garbage = archiveToGarbage('order', target);

  res.json({ success: true, orders: filtered, garbage });
});

// Preview Bill for an Order before confirming customer payment
app.post('/api/manage/orders/:orderId/preview-bill', requireAllowedIp, requireManageCode, (req, res) => {
  const { orderId } = req.params;
  const { endDate, customItems = [], custEmail } = req.body || {};
  if (!endDate || !String(endDate).trim()) {
    return res.status(400).json({ error: 'End date is required to preview bill.' });
  }
  const orders = getOrdersFromDB();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }
  const normalizedCustomItems = Array.isArray(customItems)
    ? customItems
      .filter((ci) => ci && String(ci.name || '').trim() && Number.isFinite(Number(ci.amount)) && Number(ci.amount) >= 0)
      .map((ci) => ({
        name: String(ci.name).trim(),
        amount: Number(Number(ci.amount).toFixed(2))
      }))
    : [];
  const tempCustomer = {
    customerId: `CUST-PREVIEW`,
    orderId: order.orderId,
    custName: order.custName,
    custWhatsApp: order.custWhatsApp,
    custEmail: String(custEmail || order.custEmail || '').trim(),
    packageName: order.packageName,
    deliveryArea: order.deliveryArea,
    deliveryTimeSlot: order.deliveryTimeSlot,
    fullAddress: order.fullAddress,
    startDate: order.deliveryDate,
    endDate: String(endDate).trim(),
    specialNotes: order.specialNotes || '',
    customItems: normalizedCustomItems
  };
  const bill = buildCustomerBillObject(tempCustomer);
  res.json({ bill });
});

function findDuplicateCustomerByPhone(customers, phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!digits) return null;
  return customers.find((c) => String(c.custWhatsApp || '').replace(/\D/g, '').slice(-10) === digits) || null;
}

// Move an order to Customers (requires IP + endDate) and send activation email with PDF bill
app.post('/api/manage/orders/:orderId/to-customer', requireAllowedIp, requireManageCode, async (req, res) => {
  const { orderId } = req.params;
  const { endDate, customItems = [], custEmail } = req.body || {};
  if (!endDate || !String(endDate).trim()) {
    return res.status(400).json({ error: 'End date is required to add to customers.' });
  }

  const orders = getOrdersFromDB();
  const orderIndex = orders.findIndex((o) => o.orderId === orderId);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const customers = readJsonDB(CUSTOMERS_FILE);
  const dupCust = findDuplicateInCustomers(
    customers,
    orders[orderIndex].custWhatsApp,
    custEmail || orders[orderIndex].custEmail
  );
  if (dupCust) {
    return res.status(409).json({
      error: `This ${dupCust.field} (${dupCust.value}) already exists in Customers (${dupCust.record.custName}). You can only add if the customer is in Garbage.`
    });
  }

  const [order] = orders.splice(orderIndex, 1);
  writeJsonDB(DB_FILE, orders);

  const normalizedCustomItems = Array.isArray(customItems)
    ? customItems
      .filter((ci) => ci && String(ci.name || '').trim() && Number.isFinite(Number(ci.amount)) && Number(ci.amount) >= 0)
      .map((ci) => ({
        name: String(ci.name).trim(),
        amount: Number(Number(ci.amount).toFixed(2))
      }))
    : [];

  const resolvedEmail = String(custEmail || order.custEmail || '').trim();
  const customerRecord = {
    customerId: `CUST-${Date.now().toString().slice(-6)}`,
    orderId: order.orderId,
    custName: order.custName,
    custWhatsApp: order.custWhatsApp,
    custEmail: resolvedEmail,
    packageName: order.packageName,
    planType: order.planType || 'Daily Plan',
    deliveryArea: order.deliveryArea,
    deliveryTimeSlot: order.deliveryTimeSlot,
    fullAddress: order.fullAddress,
    startDate: order.deliveryDate,
    endDate: String(endDate).trim(),
    specialNotes: order.specialNotes || '',
    customItems: normalizedCustomItems,
    isPaid: false,
    addedAt: new Date().toISOString()
  };
  customers.unshift(customerRecord);
  writeJsonDB(CUSTOMERS_FILE, customers);
  const garbage = removePhoneFromGarbage(customerRecord.custWhatsApp, customerRecord.custEmail);

  const bill = buildCustomerBillObject(customerRecord);
  let emailStatus = { sent: false, reason: 'Not attempted' };
  try {
    emailStatus = await sendActivationEmail({
      customer: customerRecord,
      bill,
      smtpConfig: getSmtpConfig()
    });
    serverLogger.write(emailStatus.sent ? 'INFO' : 'WARN', 'ACTIVATION_EMAIL', {
      customerId: customerRecord.customerId,
      email: customerRecord.custEmail,
      billNo: bill.billNo,
      emailStatus
    });
  } catch (mailErr) {
    emailStatus = { sent: false, reason: mailErr.message };
    serverLogger.write('ERROR', 'ACTIVATION_EMAIL_FAILED', {
      customerId: customerRecord.customerId,
      email: customerRecord.custEmail,
      error: mailErr.message
    });
  }

  res.status(201).json({ success: true, customer: customerRecord, orders, customers, garbage, bill, emailStatus });
});

// List all customers (requires IP + secret code)
app.get('/api/manage/customers', requireAllowedIp, requireManageCode, (req, res) => {
  const customers = readJsonDB(CUSTOMERS_FILE);
  res.json({ total: customers.length, customers });
});

// Direct Add Customer (from Garbage lookup or Manual entry)
app.post('/api/manage/customers/direct', requireAllowedIp, requireManageCode, async (req, res) => {
  const {
    custName,
    custWhatsApp,
    custEmail = '',
    packageName = 'Only Lunch - Pure Veg',
    deliveryArea = 'Guduvancherry',
    deliveryTimeSlot = 'Afternoon Lunch (12:00 PM - 1:00 PM)',
    fullAddress = 'Address will be provided',
    startDate,
    endDate,
    specialNotes = '',
    customItems = []
  } = req.body || {};

  if (!custName || !String(custName).trim() || !custWhatsApp || !String(custWhatsApp).trim()) {
    return res.status(400).json({ error: 'Customer Name and Phone Number are required.' });
  }
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Start Date and End Date are required.' });
  }

  const normalizedCustomItems = Array.isArray(customItems)
    ? customItems
        .filter((ci) => ci && String(ci.name || '').trim() && Number.isFinite(Number(ci.amount)) && Number(ci.amount) >= 0)
        .map((ci) => ({
          name: String(ci.name).trim(),
          amount: Number(Number(ci.amount).toFixed(2))
        }))
    : [];

  const customers = readJsonDB(CUSTOMERS_FILE);
  const dupCust = findDuplicateInCustomers(customers, custWhatsApp, custEmail);
  if (dupCust) {
    return res.status(409).json({
      error: `This ${dupCust.field} (${dupCust.value}) already exists in Customers (${dupCust.record.custName}). You can only add if the customer is in Garbage.`
    });
  }

  // If this person has a pending order in orders.json, clear it from orders.json when adding to customers
  const phone10 = normalizePhone10(custWhatsApp);
  const emailNorm = normalizeEmail(custEmail);
  const currentOrders = getOrdersFromDB();
  const matchedOrder = currentOrders.find(
    (o) => (phone10 && normalizePhone10(o.custWhatsApp) === phone10) || (emailNorm && normalizeEmail(o.custEmail) === emailNorm)
  );
  const remainingOrders = matchedOrder
    ? currentOrders.filter(
        (o) =>
          !(phone10 && normalizePhone10(o.custWhatsApp) === phone10) &&
          !(emailNorm && normalizeEmail(o.custEmail) === emailNorm)
      )
    : currentOrders;
  if (matchedOrder) {
    writeJsonDB(DB_FILE, remainingOrders);
  }

  const customerRecord = {
    customerId: `CUST-${Date.now().toString().slice(-6)}`,
    orderId: matchedOrder ? matchedOrder.orderId : `MANUAL-${Date.now().toString().slice(-6)}`,
    custName: String(custName).trim(),
    custWhatsApp: String(custWhatsApp).trim(),
    custEmail: String(custEmail || '').trim(),
    packageName: String(packageName || 'Only Lunch - Pure Veg').trim(),
    planType: 'Daily Plan',
    deliveryArea: String(deliveryArea || 'Guduvancherry').trim(),
    deliveryTimeSlot: String(deliveryTimeSlot || 'Afternoon Lunch (12:00 PM - 1:00 PM)').trim(),
    fullAddress: String(fullAddress || 'Address will be provided').trim(),
    startDate: String(startDate).trim(),
    endDate: String(endDate).trim(),
    specialNotes: String(specialNotes || '').trim(),
    customItems: normalizedCustomItems,
    isPaid: false,
    addedAt: new Date().toISOString()
  };

  customers.unshift(customerRecord);
  writeJsonDB(CUSTOMERS_FILE, customers);
  const garbage = removePhoneFromGarbage(customerRecord.custWhatsApp, customerRecord.custEmail);

  const bill = buildCustomerBillObject(customerRecord);
  let emailStatus = { sent: false, reason: 'Not attempted' };
  try {
    emailStatus = await sendActivationEmail({
      customer: customerRecord,
      bill,
      smtpConfig: getSmtpConfig()
    });
    serverLogger.write(emailStatus.sent ? 'INFO' : 'WARN', 'DIRECT_CUSTOMER_EMAIL', {
      customerId: customerRecord.customerId,
      email: customerRecord.custEmail,
      billNo: bill.billNo,
      emailStatus
    });
  } catch (mailErr) {
    emailStatus = { sent: false, reason: mailErr.message };
    serverLogger.write('ERROR', 'DIRECT_CUSTOMER_EMAIL_FAILED', {
      customerId: customerRecord.customerId,
      email: customerRecord.custEmail,
      error: mailErr.message
    });
  }

  res.status(201).json({
    success: true,
    customer: customerRecord,
    customers,
    orders: enrichOrdersWithEstimate(remainingOrders),
    garbage,
    bill,
    emailStatus
  });
});

// Activate / Renew an expired customer (requires secret code + new endDate, optional startDate)
app.patch('/api/manage/customers/:customerId/paid', requireAllowedIp, requireManageCode, (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate } = req.body || {};

  if (!endDate || !String(endDate).trim()) {
    return res.status(400).json({ error: 'New End Date is required to activate.' });
  }

  const customers = readJsonDB(CUSTOMERS_FILE);
  const idx = customers.findIndex((c) => c.customerId === customerId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const customer = customers[idx];
  if (startDate && String(startDate).trim()) {
    customer.startDate = String(startDate).trim();
  }
  customer.endDate = String(endDate).trim();
  customer.paidCleared = false;
  customer.isPaid = false;
  customer.paidUpdatedAt = new Date().toISOString();

  customers[idx] = customer;
  writeJsonDB(CUSTOMERS_FILE, customers);
  res.json({ success: true, customer, customers });
});

// Add days to a customer's existing endDate (Add% action)
app.patch('/api/manage/customers/:customerId/add-days', requireAllowedIp, (req, res) => {
  const { customerId } = req.params;
  const days = parseInt(req.body?.days, 10);
  if (!Number.isInteger(days) || days < 1) {
    return res.status(400).json({ error: 'Days must be at least 1.' });
  }

  const customers = readJsonDB(CUSTOMERS_FILE);
  const idx = customers.findIndex((c) => c.customerId === customerId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const customer = customers[idx];
  const baseDateStr = customer.endDate || new Date().toISOString().split('T')[0];
  const parts = baseDateStr.split('-').map(Number);
  const baseDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  baseDate.setUTCDate(baseDate.getUTCDate() + days);

  customer.endDate = baseDate.toISOString().split('T')[0];
  customer.paidCleared = false;
  customer.isPaid = false;
  customer.extendedAt = new Date().toISOString();

  customers[idx] = customer;
  writeJsonDB(CUSTOMERS_FILE, customers);
  res.json({ success: true, customer, customers });
});

// Update an existing customer's details (Edit pen button)
app.put('/api/manage/customers/:customerId', requireAllowedIp, requireManageCode, (req, res) => {
  const { customerId } = req.params;
  const {
    custName,
    custWhatsApp,
    custEmail = '',
    packageName,
    deliveryArea,
    deliveryTimeSlot,
    fullAddress,
    startDate,
    endDate,
    specialNotes = ''
  } = req.body || {};

  if (!custName || !String(custName).trim() || !custWhatsApp || !String(custWhatsApp).trim()) {
    return res.status(400).json({ error: 'Customer Name and Phone Number are required.' });
  }

  const customers = readJsonDB(CUSTOMERS_FILE);
  const idx = customers.findIndex((c) => c.customerId === customerId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const dupOther = findDuplicateInCustomers(customers, custWhatsApp, custEmail, customerId);
  if (dupOther) {
    return res.status(409).json({
      error: `This ${dupOther.field} (${dupOther.value}) already exists for another customer (${dupOther.record.custName}).`
    });
  }

  const existing = customers[idx];
  customers[idx] = {
    ...existing,
    custName: String(custName).trim(),
    custWhatsApp: String(custWhatsApp).trim(),
    custEmail: String(custEmail || '').trim(),
    packageName: packageName ? String(packageName).trim() : existing.packageName,
    deliveryArea: deliveryArea !== undefined ? String(deliveryArea).trim() : existing.deliveryArea,
    deliveryTimeSlot: deliveryTimeSlot !== undefined ? String(deliveryTimeSlot).trim() : existing.deliveryTimeSlot,
    fullAddress: fullAddress !== undefined ? String(fullAddress).trim() : existing.fullAddress,
    startDate: startDate ? String(startDate).trim() : existing.startDate,
    endDate: endDate ? String(endDate).trim() : existing.endDate,
    specialNotes: String(specialNotes || '').trim(),
    updatedAt: new Date().toISOString()
  };

  writeJsonDB(CUSTOMERS_FILE, customers);
  res.json({ success: true, customer: customers[idx], customers });
});

// Update an existing order (Edit pen button - requires Secret PIN)
app.put('/api/manage/orders/:orderId', requireAllowedIp, requireManageCode, (req, res) => {
  const { orderId } = req.params;
  const {
    custName,
    custWhatsApp,
    custEmail = '',
    packageName,
    deliveryArea,
    deliveryTimeSlot,
    fullAddress,
    startDate,
    specialNotes = ''
  } = req.body || {};

  if (!custName || !String(custName).trim() || !custWhatsApp || !String(custWhatsApp).trim()) {
    return res.status(400).json({ error: 'Customer Name and Phone Number are required.' });
  }

  const orders = getOrdersFromDB();
  const idx = orders.findIndex((o) => o.orderId === orderId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const newPhone10 = normalizePhone10(custWhatsApp);
  const newEmailNorm = normalizeEmail(custEmail);
  const duplicateOther = orders.find(
    (o) =>
      o.orderId !== orderId &&
      ((newPhone10 && normalizePhone10(o.custWhatsApp) === newPhone10) ||
        (newEmailNorm && normalizeEmail(o.custEmail) === newEmailNorm))
  );
  if (duplicateOther) {
    return res.status(409).json({
      error: `This phone or email already exists for another order (${duplicateOther.custName}).`
    });
  }

  const existing = orders[idx];
  orders[idx] = {
    ...existing,
    custName: String(custName).trim(),
    custWhatsApp: String(custWhatsApp).trim(),
    custEmail: String(custEmail || '').trim(),
    packageName: packageName ? String(packageName).trim() : existing.packageName,
    deliveryArea: deliveryArea !== undefined ? String(deliveryArea).trim() : existing.deliveryArea,
    deliveryTimeSlot: deliveryTimeSlot !== undefined ? String(deliveryTimeSlot).trim() : existing.deliveryTimeSlot,
    fullAddress: fullAddress !== undefined ? String(fullAddress).trim() : existing.fullAddress,
    deliveryDate: startDate ? String(startDate).trim() : existing.deliveryDate,
    specialNotes: String(specialNotes || '').trim(),
    updatedAt: new Date().toISOString()
  };

  writeJsonDB(DB_FILE, orders);
  res.json({ success: true, order: orders[idx], orders: enrichOrdersWithEstimate(orders) });
});

// Update an archived garbage record (Edit pen button - requires Secret PIN)
app.put('/api/manage/garbage/:garbageId', requireAllowedIp, requireManageCode, (req, res) => {
  const { garbageId } = req.params;
  const {
    custName,
    custWhatsApp,
    custEmail = '',
    packageName,
    deliveryArea,
    deliveryTimeSlot,
    fullAddress,
    startDate,
    endDate = '',
    specialNotes = ''
  } = req.body || {};

  if (!custName || !String(custName).trim() || !custWhatsApp || !String(custWhatsApp).trim()) {
    return res.status(400).json({ error: 'Customer Name and Phone Number are required.' });
  }

  const garbage = readJsonDB(GARBAGE_FILE);
  const idx = garbage.findIndex((g) => g.garbageId === garbageId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Garbage record not found.' });
  }

  const newPhone10 = normalizePhone10(custWhatsApp);
  const newEmailNorm = normalizeEmail(custEmail);
  const duplicateOther = garbage.find(
    (g) =>
      g.garbageId !== garbageId &&
      ((newPhone10 && normalizePhone10(g?.item?.custWhatsApp) === newPhone10) ||
        (newEmailNorm && normalizeEmail(g?.item?.custEmail) === newEmailNorm))
  );
  if (duplicateOther) {
    return res.status(409).json({
      error: `This phone or email already exists in Garbage (${duplicateOther.item?.custName || ''}).`
    });
  }

  const entry = garbage[idx];
  const prevItem = entry.item || {};
  const updatedItem = {
    ...prevItem,
    custName: String(custName).trim(),
    custWhatsApp: String(custWhatsApp).trim(),
    custEmail: String(custEmail || '').trim(),
    packageName: packageName ? String(packageName).trim() : prevItem.packageName,
    deliveryArea: deliveryArea !== undefined ? String(deliveryArea).trim() : prevItem.deliveryArea,
    deliveryTimeSlot: deliveryTimeSlot !== undefined ? String(deliveryTimeSlot).trim() : prevItem.deliveryTimeSlot,
    fullAddress: fullAddress !== undefined ? String(fullAddress).trim() : prevItem.fullAddress,
    specialNotes: String(specialNotes || '').trim(),
    updatedAt: new Date().toISOString()
  };
  if (startDate && String(startDate).trim()) {
    if (entry.type === 'order') updatedItem.deliveryDate = String(startDate).trim();
    else updatedItem.startDate = String(startDate).trim();
  }
  if (endDate !== undefined && String(endDate).trim()) {
    updatedItem.endDate = String(endDate).trim();
  }

  garbage[idx] = { ...entry, item: updatedItem };
  writeJsonDB(GARBAGE_FILE, garbage);
  res.json({ success: true, entry: garbage[idx], garbage });
});

// Generate Customer Bill automatically using .env menu prices and GST
app.get('/api/manage/customers/:customerId/bill', requireAllowedIp, requireManageCode, (req, res) => {
  const { customerId } = req.params;
  const customers = readJsonDB(CUSTOMERS_FILE);
  const customer = customers.find((c) => c.customerId === customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const bill = buildCustomerBillObject(customer);
  res.json({ bill });
});

// Delete a customer and archive to garbage list (requires IP + secret code)
app.delete('/api/manage/customers/:customerId', requireAllowedIp, requireManageCode, (req, res) => {
  const { customerId } = req.params;
  const customers = readJsonDB(CUSTOMERS_FILE);
  const target = customers.find((c) => c.customerId === customerId);
  if (!target) {
    return res.status(404).json({ error: 'Customer not found.' });
  }
  const filtered = customers.filter((c) => c.customerId !== customerId);
  writeJsonDB(CUSTOMERS_FILE, filtered);

  const garbage = archiveToGarbage('customer', target);

  res.json({ success: true, customers: filtered, garbage });
});

// List garbage archive (deleted orders & customers)
app.get('/api/manage/garbage', requireAllowedIp, requireManageCode, (req, res) => {
  const garbage = readJsonDB(GARBAGE_FILE);
  res.json({ total: garbage.length, garbage });
});

// Send 2-day reminder emails to all pending orders that are >= 48 hours since creation or last reminder
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
let reminderJobRunning = false;

async function processTwoDayOrderReminders() {
  if (reminderJobRunning) return { skipped: true, reason: 'Already running' };
  reminderJobRunning = true;
  const results = [];
  try {
    const orders = getOrdersFromDB();
    const nowMs = Date.now();
    const smtpConfig = getSmtpConfig();
    let changed = false;

    for (let i = 0; i < orders.length; i++) {
      const ord = orders[i];
      if (!ord.custEmail || !ord.custEmail.includes('@')) continue;
      const lastRef = ord.lastReminderAt || ord.createdAt;
      const lastMs = lastRef ? new Date(lastRef).getTime() : 0;
      if (!Number.isFinite(lastMs) || nowMs - lastMs < TWO_DAYS_MS) continue;

      try {
        const status = await sendOrderReminderEmail({
          order: ord,
          smtpConfig,
          contactPhone: '7200451980'
        });
        if (status.sent) {
          orders[i].lastReminderAt = new Date().toISOString();
          changed = true;
        }
        results.push({ orderId: ord.orderId, email: ord.custEmail, ...status });
        serverLogger.write(status.sent ? 'INFO' : 'WARN', 'ORDER_REMINDER_EMAIL', {
          orderId: ord.orderId,
          email: ord.custEmail,
          status
        });
      } catch (err) {
        results.push({ orderId: ord.orderId, email: ord.custEmail, sent: false, reason: err.message });
        serverLogger.write('ERROR', 'ORDER_REMINDER_EMAIL_FAILED', {
          orderId: ord.orderId,
          email: ord.custEmail,
          error: err.message
        });
      }
    }

    if (changed) {
      writeJsonDB(DB_FILE, orders);
    }
    return { processed: results.length, results };
  } finally {
    reminderJobRunning = false;
  }
}

// Optional manual trigger endpoint for 2-day order reminders
app.post('/api/manage/orders/send-reminders', requireAllowedIp, requireManageCode, async (req, res) => {
  const summary = await processTwoDayOrderReminders();
  res.json({ success: true, ...summary });
});

// Frontend Client Log Ingestion -> C:\homefood\client\log1..log10
app.post('/api/logs/client', (req, res) => {
  const { level = 'INFO', event = 'CLIENT_EVENT', details = {}, url = '' } = req.body || {};
  clientLogger.write(String(level).toUpperCase(), event, {
    ip: getClientIp(req),
    url,
    ...details
  });
  res.status(204).end();
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    serverLogger.write('INFO', 'SERVER_START', {
      port: PORT,
      allowedIps: getAllowedIps()
    });
    setTimeout(() => {
      processTwoDayOrderReminders().catch(() => {});
    }, 15000);
    setInterval(() => {
      processTwoDayOrderReminders().catch(() => {});
    }, 60 * 60 * 1000);
    console.log(`\n======================================================`);
    console.log(`Sri Lakshmi HomeFood Server Running:`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://192.168.24.42:${PORT}`);
    console.log(`======================================================\n`);
    console.log(`Orders will settle in: ${DB_FILE}`);
  });
}

module.exports = app;

process.on('uncaughtException', (err) => {
  serverLogger.write('ERROR', 'UNCAUGHT_EXCEPTION', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  serverLogger.write('ERROR', 'UNHANDLED_REJECTION', { reason: String(reason) });
});
