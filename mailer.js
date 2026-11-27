const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

function generateBillPdfBuffer(bill) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A5', margin: 36 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(18).fillColor('#2c1a0e').text('Sri Lakshmi Foods', { align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor('#6b3a2a').text('Homestyle Food Catering & Monthly Subscriptions', { align: 'center' });
      doc.text(`FSSAI: ${bill.fssai}`, { align: 'center' });
      doc.moveDown(0.7);
      doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).dash(3, { space: 3 }).strokeColor('#c8813a').stroke().undash();
      doc.moveDown(0.7);

      const meta = [
        ['Bill No', bill.billNo],
        ['Date', `${bill.date}  ${bill.time}`],
        ['Customer', bill.customerName],
        ['Phone', bill.phone],
        ['Email', bill.email || '-'],
        ['Start Date', bill.startDate || '-'],
        ['End Date', bill.endDate || '-'],
        ['Validity', `${bill.validityDays} day(s)`],
        ['Time Slot', bill.timeSlot || '-'],
        ['Delivery Area', bill.deliveryArea || '-']
      ];

      doc.fontSize(8.5).fillColor('#2c1a0e');
      meta.forEach(([k, v]) => {
        const y = doc.y;
        doc.font('Helvetica-Bold').text(`${k}:`, 36, y, { width: 90 });
        doc.font('Helvetica').text(String(v), 130, y, { width: doc.page.width - 166 });
      });

      doc.moveDown(0.6);
      doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).dash(3, { space: 3 }).strokeColor('#c8813a').stroke().undash();
      doc.moveDown(0.6);

      // Table header
      const headerY = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#6b3a2a');
      doc.text('Plan / Item', 36, headerY, { width: 200 });
      doc.text('Qty/Days', 240, headerY, { width: 55, align: 'center' });
      doc.text('Amount', doc.page.width - 116, headerY, { width: 80, align: 'right' });
      doc.moveDown(0.4);
      doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor('#2c1a0e').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Main Plan Item
      const planY = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#2c1a0e');
      doc.text(bill.planName, 36, planY, { width: 200 });
      doc.text(String(bill.validityDays), 240, planY, { width: 55, align: 'center' });
      doc.text(`Rs.${bill.planTotal.toFixed(2)}`, doc.page.width - 116, planY, { width: 80, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#6b3a2a').text(`Rs.${bill.unitPrice} / day x ${bill.validityDays} days`, 40, doc.y);
      doc.moveDown(0.4);

      // Custom Items (if any)
      if (Array.isArray(bill.customItems) && bill.customItems.length > 0) {
        bill.customItems.forEach((ci) => {
          const cy = doc.y;
          doc.font('Helvetica').fontSize(9).fillColor('#2c1a0e');
          doc.text(ci.name, 36, cy, { width: 200 });
          doc.text('1', 240, cy, { width: 55, align: 'center' });
          doc.text(`Rs.${Number(ci.amount).toFixed(2)}`, doc.page.width - 116, cy, { width: 80, align: 'right' });
          doc.moveDown(0.3);
        });
      }

      doc.moveDown(0.4);
      doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).dash(3, { space: 3 }).strokeColor('#c8813a').stroke().undash();
      doc.moveDown(0.5);

      const drawSummaryRow = (label, value, bold = false) => {
        const sy = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 8.5).fillColor('#2c1a0e');
        doc.text(label, 36, sy, { width: 220 });
        doc.text(value, doc.page.width - 116, sy, { width: 80, align: 'right' });
        doc.moveDown(0.2);
      };

      drawSummaryRow('Subtotal', `Rs.${bill.subtotal.toFixed(2)}`);
      drawSummaryRow(`CGST (${(bill.gstPercent / 2).toFixed(2)}%)`, `Rs.${bill.cgstAmount.toFixed(2)}`);
      drawSummaryRow(`SGST (${(bill.gstPercent / 2).toFixed(2)}%)`, `Rs.${bill.sgstAmount.toFixed(2)}`);
      doc.moveDown(0.2);
      doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor('#2c1a0e').lineWidth(1).stroke();
      doc.moveDown(0.4);
      drawSummaryRow('GRAND TOTAL', `Rs.${bill.grandTotal.toFixed(2)}`, true);

      doc.moveDown(1);
      doc.font('Helvetica').fontSize(8.5).fillColor('#6b3a2a').text('Thank you for choosing Sri Lakshmi Foods!', { align: 'center' });
      doc.fontSize(7.5).text('Fresh Daily Homestyle Cooking', { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function buildTransporter(smtpConfig) {
  const cleanPass = String(smtpConfig.SMTP_PASS || '').replace(/\s+/g, '');
  return nodemailer.createTransport({
    host: smtpConfig.SMTP_HOST || 'smtp.gmail.com',
    port: Number(smtpConfig.SMTP_PORT || 587),
    secure: String(smtpConfig.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: smtpConfig.SMTP_USER,
      pass: cleanPass
    }
  });
}

function getLogoContext() {
  const logoPngPath = path.join(__dirname, 'logo-leaf.png');
  const hasLogoPng = fs.existsSync(logoPngPath);
  const logoHtml = hasLogoPng
    ? `<img src="cid:srilakshmi-logo" alt="Sri Lakshmi HomeFood" style="height:56px;width:auto;display:block;margin:0 auto;" />`
    : `<div style="font-size:22px;font-weight:800;color:#111827;">Sri Lakshmi HomeFood</div>`;
  const logoAttachment = hasLogoPng
    ? { filename: 'logo-leaf.png', path: logoPngPath, cid: 'srilakshmi-logo' }
    : null;
  return { logoHtml, logoAttachment };
}

async function sendActivationEmail({ customer, bill, smtpConfig }) {
  if (!customer.custEmail || !customer.custEmail.includes('@')) {
    return { sent: false, reason: 'No valid customer email address provided.' };
  }
  if (!smtpConfig.SMTP_USER || !smtpConfig.SMTP_PASS) {
    return { sent: false, reason: 'SMTP credentials (SMTP_USER / SMTP_PASS) not configured in backend/.env.' };
  }

  const transporter = buildTransporter(smtpConfig);
  const pdfBuffer = await generateBillPdfBuffer(bill);

  const customRowsHtml = (bill.customItems || [])
    .map(
      (ci) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#111827;">${ci.name}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;color:#111827;font-weight:600;">&#8377;${Number(ci.amount).toFixed(2)}</td>
      </tr>`
    )
    .join('');

  const { logoHtml, logoAttachment } = getLogoContext();

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f9fafb;padding:24px;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      <!-- Clean White Header with Only the Colorful Navbar Logo -->
      <div style="background:#ffffff;padding:24px 28px 18px;text-align:center;border-bottom:1px solid #e5e7eb;">
        ${logoHtml}
        <div style="color:#4b5563;font-size:11px;margin-top:8px;letter-spacing:0.8px;text-transform:uppercase;">
          Homestyle Food Catering &amp; Monthly Subscriptions
        </div>
      </div>

      <div style="padding:28px;">
        <h2 style="margin:0 0 6px;color:#111827;font-size:19px;font-weight:700;">Dear ${customer.custName},</h2>
        <p style="margin:0 0 16px;color:#111827;font-size:15px;font-weight:700;">
          Your Plan is Activated
        </p>
        <p style="margin:0 0 20px;color:#374151;font-size:13.5px;line-height:1.6;">
          Thank you for choosing Sri Lakshmi HomeFood. Your homestyle meal subscription has been activated. Please find your plan details below and your official bill attached as a PDF.
        </p>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Bill Number</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${bill.billNo}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Selected Plan</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${bill.planName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Start Date</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${bill.startDate}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">End Date</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${bill.endDate}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Validity</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${bill.validityDays} day(s)</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Delivery Time Slot</td>
              <td style="padding:6px 0;text-align:right;color:#111827;">${bill.timeSlot}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Delivery Area</td>
              <td style="padding:6px 0;text-align:right;color:#111827;">${bill.deliveryArea}</td>
            </tr>
          </table>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
          <tr>
            <th style="text-align:left;padding:8px 0;border-bottom:1.5px solid #111827;color:#111827;">Description</th>
            <th style="text-align:right;padding:8px 0;border-bottom:1.5px solid #111827;color:#111827;">Amount</th>
          </tr>
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#111827;">
              ${bill.planName} (&#8377;${bill.unitPrice}/day &times; ${bill.validityDays} days)
            </td>
            <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;color:#111827;font-weight:600;">
              &#8377;${bill.planTotal.toFixed(2)}
            </td>
          </tr>
          ${customRowsHtml}
          <tr>
            <td style="padding:8px 0;color:#374151;">Subtotal</td>
            <td style="padding:8px 0;text-align:right;color:#111827;">&#8377;${bill.subtotal.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#374151;">GST (${bill.gstPercent}%)</td>
            <td style="padding:8px 0;text-align:right;color:#111827;">&#8377;${bill.gstAmount.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;border-top:1.5px solid #111827;font-weight:800;font-size:15px;color:#111827;">Grand Total</td>
            <td style="padding:10px 0;border-top:1.5px solid #111827;text-align:right;font-weight:800;font-size:15px;color:#111827;">&#8377;${bill.grandTotal.toFixed(2)}</td>
          </tr>
        </table>

        <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11.5px;text-align:center;">
          FSSAI LIC: ${bill.fssai} &bull; Fresh Daily Homestyle Cooking
        </p>
      </div>
    </div>
  </div>`;

  const attachments = [
    {
      filename: `SriLakshmiFoods_Bill_${bill.billNo}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf'
    }
  ];

  if (logoAttachment) {
    attachments.push(logoAttachment);
  }

  const info = await transporter.sendMail({
    from: `"${smtpConfig.SMTP_FROM_NAME || 'Sri Lakshmi HomeFood'}" <${smtpConfig.SMTP_USER}>`,
    to: customer.custEmail,
    subject: `Your Plan is Activated - Sri Lakshmi HomeFood (${bill.billNo})`,
    html,
    attachments
  });

  return { sent: true, messageId: info.messageId };
}

async function sendOrderReceivedEmail({ order, smtpConfig, contactPhone = '7200451980' }) {
  if (!order.custEmail || !order.custEmail.includes('@')) {
    return { sent: false, reason: 'No valid customer email address provided.' };
  }
  if (!smtpConfig.SMTP_USER || !smtpConfig.SMTP_PASS) {
    return { sent: false, reason: 'SMTP credentials (SMTP_USER / SMTP_PASS) not configured in backend/.env.' };
  }

  const transporter = buildTransporter(smtpConfig);
  const { logoHtml, logoAttachment } = getLogoContext();

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f9fafb;padding:24px;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      <!-- Clean White Header with Only the Colorful Navbar Logo -->
      <div style="background:#ffffff;padding:24px 28px 18px;text-align:center;border-bottom:1px solid #e5e7eb;">
        ${logoHtml}
        <div style="color:#4b5563;font-size:11px;margin-top:8px;letter-spacing:0.8px;text-transform:uppercase;">
          Homestyle Food Catering &amp; Monthly Subscriptions
        </div>
      </div>

      <div style="padding:28px;">
        <h2 style="margin:0 0 8px;color:#111827;font-size:19px;font-weight:700;">Dear ${order.custName},</h2>
        <p style="margin:0 0 18px;color:#111827;font-size:14.5px;line-height:1.6;font-weight:600;">
          Your Request for ${order.packageName} from Sri Lakshmi HomeFood has been received. Our team will contact you shortly.
        </p>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Order Reference</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${order.orderId}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Requested Plan</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${order.packageName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Preferred Start Date</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${order.deliveryDate}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Time Slot</td>
              <td style="padding:6px 0;text-align:right;color:#111827;">${order.deliveryTimeSlot}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Delivery Area</td>
              <td style="padding:6px 0;text-align:right;color:#111827;">${order.deliveryArea}</td>
            </tr>
          </table>
        </div>

        <div style="padding:14px 18px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;color:#111827;">
          <div style="font-weight:700;margin-bottom:4px;">Need Immediate Assistance?</div>
          <div style="color:#374151;">Call or WhatsApp us at <strong style="color:#111827;">+91 ${contactPhone}</strong></div>
        </div>

        <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11.5px;text-align:center;">
          FSSAI LIC: 22423567000189 &bull; Fresh Daily Homestyle Cooking
        </p>
      </div>
    </div>
  </div>`;

  const attachments = logoAttachment ? [logoAttachment] : [];
  const info = await transporter.sendMail({
    from: `"${smtpConfig.SMTP_FROM_NAME || 'Sri Lakshmi HomeFood'}" <${smtpConfig.SMTP_USER}>`,
    to: order.custEmail,
    subject: `Request Received - ${order.packageName} | Sri Lakshmi HomeFood (${order.orderId})`,
    html,
    attachments
  });

  return { sent: true, messageId: info.messageId };
}

async function sendOrderReminderEmail({ order, smtpConfig, contactPhone = '7200451980' }) {
  if (!order.custEmail || !order.custEmail.includes('@')) {
    return { sent: false, reason: 'No valid customer email address provided.' };
  }
  if (!smtpConfig.SMTP_USER || !smtpConfig.SMTP_PASS) {
    return { sent: false, reason: 'SMTP credentials (SMTP_USER / SMTP_PASS) not configured in backend/.env.' };
  }

  const transporter = buildTransporter(smtpConfig);
  const { logoHtml, logoAttachment } = getLogoContext();

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f9fafb;padding:24px;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      <!-- Clean White Header with Only the Colorful Navbar Logo -->
      <div style="background:#ffffff;padding:24px 28px 18px;text-align:center;border-bottom:1px solid #e5e7eb;">
        ${logoHtml}
        <div style="color:#4b5563;font-size:11px;margin-top:8px;letter-spacing:0.8px;text-transform:uppercase;">
          Homestyle Food Catering &amp; Monthly Subscriptions
        </div>
      </div>

      <div style="padding:28px;">
        <h2 style="margin:0 0 8px;color:#111827;font-size:19px;font-weight:700;">Dear ${order.custName},</h2>
        <p style="margin:0 0 14px;color:#111827;font-size:15px;font-weight:700;">
          Start Your Homestyle Meal Today!
        </p>
        <p style="margin:0 0 20px;color:#374151;font-size:13.5px;line-height:1.6;">
          This is a friendly reminder regarding your request for <strong>${order.packageName}</strong> from Sri Lakshmi HomeFood. Fresh, hygienic home-cooked meals are ready to be scheduled for you—confirm your plan today to start your daily delivery.
        </p>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Order Reference</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${order.orderId}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Selected Plan</td>
              <td style="padding:6px 0;text-align:right;font-weight:700;color:#111827;">${order.packageName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Time Slot</td>
              <td style="padding:6px 0;text-align:right;color:#111827;">${order.deliveryTimeSlot}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#4b5563;">Delivery Area</td>
              <td style="padding:6px 0;text-align:right;color:#111827;">${order.deliveryArea}</td>
            </tr>
          </table>
        </div>

        <div style="padding:14px 18px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;color:#111827;">
          <div style="font-weight:700;margin-bottom:4px;">Ready to Start Your Plan?</div>
          <div style="color:#374151;">Call or WhatsApp us at <strong style="color:#111827;">+91 ${contactPhone}</strong> to activate your meal delivery today.</div>
        </div>

        <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11.5px;text-align:center;">
          FSSAI LIC: 22423567000189 &bull; Fresh Daily Homestyle Cooking
        </p>
      </div>
    </div>
  </div>`;

  const attachments = logoAttachment ? [logoAttachment] : [];
  const info = await transporter.sendMail({
    from: `"${smtpConfig.SMTP_FROM_NAME || 'Sri Lakshmi HomeFood'}" <${smtpConfig.SMTP_USER}>`,
    to: order.custEmail,
    subject: `Start Your Meal Today - ${order.packageName} | Sri Lakshmi HomeFood (${order.orderId})`,
    html,
    attachments
  });

  return { sent: true, messageId: info.messageId };
}

module.exports = {
  generateBillPdfBuffer,
  sendActivationEmail,
  sendOrderReceivedEmail,
  sendOrderReminderEmail
};
