'use strict';

const BREVO_API = 'https://api.brevo.com/v3';
const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function configuration() {
  return {
    apiKey: process.env.BREVO_API_KEY,
    listId: /^\d+$/.test(process.env.BREVO_LIST_ID || '')
      ? Number(process.env.BREVO_LIST_ID)
      : null,
    senderEmail: process.env.BREVO_SENDER_EMAIL,
    senderName: process.env.BREVO_SENDER_NAME,
    firebaseApiKey: process.env.FIREBASE_API_KEY,
    adminUid: process.env.FIREBASE_ADMIN_UID,
  };
}

function missingConfiguration(config) {
  return [
    ['BREVO_API_KEY', config.apiKey],
    ['BREVO_LIST_ID', config.listId],
    ['BREVO_SENDER_EMAIL', config.senderEmail],
    ['BREVO_SENDER_NAME', config.senderName],
    ['FIREBASE_API_KEY', config.firebaseApiKey],
    ['FIREBASE_ADMIN_UID', config.adminUid],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

async function verifyAdmin(req, config) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin || !host || new URL(origin).host !== host) {
    throw Object.assign(new Error('This request must come from the admin website.'), {
      status: 403,
    });
  }

  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw Object.assign(new Error('Sign in again before broadcasting.'), {
      status: 401,
    });
  }

  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
      encodeURIComponent(config.firebaseApiKey),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: match[1] }),
    },
  );
  if (!response.ok) {
    throw Object.assign(new Error('Your admin session has expired. Sign in again.'), {
      status: 401,
    });
  }
  const data = await response.json();
  if (!data.users || !data.users.some((account) => account.localId === config.adminUid)) {
    throw Object.assign(new Error('Only the configured admin account can send campaigns.'), {
      status: 403,
    });
  }
}

async function brevoRequest(path, method, payload, config) {
  const response = await fetch(BREVO_API + path, {
    method,
    headers: {
      'api-key': config.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('Brevo returned an unreadable response.');
    }
  }
  if (!response.ok) {
    const message =
      (data.message && String(data.message)) ||
      (data.code && String(data.code)) ||
      'Brevo request failed (' + response.status + ').';
    throw Object.assign(new Error(message.slice(0, 400)), {
      status: 502,
    });
  }
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char];
  });
}

module.exports = async function newsletterHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  const config = configuration();
  if (missingConfiguration(config).length) {
    return sendJson(res, 503, {
      error: 'Newsletter broadcasting is not configured yet.',
      missing: missingConfiguration(config),
    });
  }

  try {
    await verifyAdmin(req, config);
    const body = req.body || {};

    if (body.action === 'status') {
      return sendJson(res, 200, { configured: true });
    }

    if (body.action === 'sync') {
      if (!Array.isArray(body.emails) || body.emails.length < 1 || body.emails.length > 20000) {
        return sendJson(res, 400, { error: 'The subscriber list is empty or too large to sync.' });
      }
      const emails = Array.from(
        new Set(
          body.emails
            .map((email) => String(email).trim().toLowerCase())
            .filter((email) => email.length <= 120 && EMAIL_RE.test(email)),
        ),
      );
      if (!emails.length) {
        return sendJson(res, 400, { error: 'No valid subscriber email addresses were found.' });
      }

      const imported = await brevoRequest(
        '/contacts/import',
        'POST',
        {
          jsonBody: emails.map((email) => ({ email })),
          listIds: [config.listId],
          updateExistingContacts: false,
          disableNotification: true,
        },
        config,
      );
      if (!Number.isInteger(imported.processId)) {
        throw new Error('Brevo did not return a subscriber import process ID.');
      }
      return sendJson(res, 202, {
        processId: imported.processId,
        count: emails.length,
      });
    }

    if (body.action === 'process') {
      if (!Number.isInteger(Number(body.processId)) || Number(body.processId) < 1) {
        return sendJson(res, 400, { error: 'Invalid subscriber import process.' });
      }
      const process = await brevoRequest(
        '/processes/' + Number(body.processId),
        'GET',
        undefined,
        config,
      );
      return sendJson(res, 200, {
        status: process.status,
        detail: process.status === 'failed' ? 'Brevo could not finish importing subscribers.' : undefined,
      });
    }

    if (body.action === 'broadcast') {
      const subject = String(body.subject || '').trim();
      const previewText = String(body.previewText || '').trim();
      const message = String(body.message || '').trim();
      if (subject.length < 2 || subject.length > 150) {
        return sendJson(res, 400, { error: 'Subject must be between 2 and 150 characters.' });
      }
      if (previewText.length > 180) {
        return sendJson(res, 400, { error: 'Preview text must be 180 characters or fewer.' });
      }
      if (message.length < 2 || message.length > 30000) {
        return sendJson(res, 400, { error: 'Message must be between 2 and 30,000 characters.' });
      }

      const htmlContent =
        '<!doctype html><html><body style="margin:0;background:#f9f7f4;font-family:Arial,sans-serif;color:#2c2820">' +
        '<main style="max-width:640px;margin:24px auto;padding:32px;background:#fff;line-height:1.7">' +
        '<p style="margin:0 0 20px;font-size:18px;font-weight:bold">Bisbag Creations</p>' +
        '<div style="white-space:pre-wrap">' +
        escapeHtml(message) +
        '</div><hr style="margin:28px 0;border:0;border-top:1px solid #e0ddd8">' +
        '<p style="font-size:12px;color:#6b6560">You are receiving this because you subscribed to Bisbag Creations updates. ' +
        '<a href="{{ unsubscribe }}" style="color:#c8421a">Unsubscribe</a></p></main></body></html>';

      const campaign = await brevoRequest(
        '/emailCampaigns',
        'POST',
        {
          name: 'Bisbag newsletter ' + new Date().toISOString(),
          subject,
          previewText,
          sender: {
            name: config.senderName,
            email: config.senderEmail,
          },
          recipients: { listIds: [config.listId] },
          htmlContent,
        },
        config,
      );
      if (!Number.isInteger(campaign.id)) {
        throw new Error('Brevo did not return a campaign ID.');
      }
      try {
        await brevoRequest(
          '/emailCampaigns/' + campaign.id + '/sendNow',
          'POST',
          undefined,
          config,
        );
      } catch (error) {
        error.message =
          'Campaign ' +
          campaign.id +
          ' was created but not sent. It remains a draft in Brevo. ' +
          error.message;
        throw error;
      }
      return sendJson(res, 200, { campaignId: campaign.id });
    }

    return sendJson(res, 400, { error: 'Unknown newsletter action.' });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: error.message || 'Newsletter request failed.',
    });
  }
};
