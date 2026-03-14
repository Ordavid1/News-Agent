// routes/support.js
// Two-way support chat system — chat-to-email bridge
// User sends messages via chat widget → stored in DB + emailed to admin
// Admin replies via web reply page (HMAC-signed link in email) → stored in DB → user sees in chat
// Env vars: RESEND_API_KEY, SUPPORT_EMAIL, RESEND_FROM_EMAIL, JWT_SECRET (for HMAC signing)

import express from 'express';
import crypto from 'crypto';
import { Resend } from 'resend';
import { body, param, query, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../services/supabase.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Rate limiter: 5 support messages per 15 minutes per IP
const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many messages. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const VALID_CATEGORIES = ['Bug Report', 'Feature Request', 'General', 'Account Issue'];

// ============================================
// VALIDATION SCHEMAS
// ============================================

const newConversationValidation = [
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Please provide a valid email address'),
  body('message').trim().isLength({ min: 10, max: 2000 }).withMessage('Message must be between 10 and 2000 characters'),
  body('category').trim().isIn(VALID_CATEGORIES).withMessage(`Category must be one of: ${VALID_CATEGORIES.join(', ')}`),
];

const followUpValidation = [
  body('message').trim().isLength({ min: 1, max: 2000 }).withMessage('Message must be between 1 and 2000 characters'),
];

// ============================================
// HELPERS
// ============================================

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY environment variable is not set');
  }
  return new Resend(process.env.RESEND_API_KEY);
}

function getFromEmail(conversationId) {
  const domain = (process.env.RESEND_FROM_EMAIL || '').match(/@([^>]+)/)?.[1] || 'configure.news';
  return `News Agent Support <support+${conversationId}@${domain}>`;
}

function getSupportEmail() {
  return process.env.SUPPORT_EMAIL || 'go35ub3n@duck.com';
}

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({ field: err.path, message: err.msg })),
    });
    return true;
  }
  return false;
}

function getHmacSecret() {
  return process.env.JWT_SECRET || 'default-support-hmac-key';
}

function generateReplyToken(conversationId) {
  // HMAC-SHA256 sign the conversation ID — token never expires (admin link stays valid)
  const hmac = crypto.createHmac('sha256', getHmacSecret());
  hmac.update(conversationId);
  return hmac.digest('hex');
}

function verifyReplyToken(conversationId, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = generateReplyToken(conversationId);
  // timingSafeEqual requires equal-length buffers
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

function getAppUrl() {
  return process.env.BACKEND_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
}

function getReplyUrl(conversationId) {
  const token = generateReplyToken(conversationId);
  return `${getAppUrl()}/api/support/reply/${conversationId}?token=${token}`;
}

const CATEGORY_COLORS = {
  'Bug Report': '#EF4444',
  'Feature Request': '#8B5CF6',
  'General': '#6366F1',
  'Account Issue': '#F59E0B',
};

function buildConversationEmailHtml({ name, email, message, category, timestamp, conversationHistory, conversationId }) {
  const badgeColor = CATEGORY_COLORS[category] || '#6366F1';
  const esc = (str) => String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let historyHtml = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const historyRows = conversationHistory.map(msg => {
      const isUser = msg.sender_type === 'user';
      const label = isUser ? `${esc(name)}` : 'Support';
      const labelColor = isUser ? '#6366F1' : '#059669';
      const time = new Date(msg.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });
      return `
        <tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="color:${labelColor};font-size:12px;font-weight:600;">${label}</span>
            <span style="color:#9ca3af;font-size:11px;">${time} UTC</span>
          </div>
          <p style="margin:0;color:#374151;font-size:13px;line-height:1.5;white-space:pre-wrap;">${esc(msg.message)}</p>
        </td></tr>`;
    }).join('');
    historyHtml = `
      <tr><td style="padding:0 32px 16px;">
        <p style="margin:0 0 8px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;">Previous Messages</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;">
          ${historyRows}
        </table>
      </td></tr>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f7;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#6366F1,#8B5CF6);padding:24px 32px;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">News Agent Support</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Message from ${esc(name)}</p>
        </td></tr>
        <tr><td style="padding:24px 32px 0;">
          <span style="display:inline-block;background:${badgeColor};color:#fff;font-size:12px;font-weight:600;padding:4px 12px;border-radius:20px;">${category}</span>
          <span style="color:#9ca3af;font-size:12px;margin-left:8px;">${timestamp}</span>
        </td></tr>
        <tr><td style="padding:16px 32px;">
          <div style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
            <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;white-space:pre-wrap;">${esc(message)}</p>
          </div>
        </td></tr>
        ${historyHtml}
        <tr><td style="padding:0 32px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;">
            <tr><td style="color:#9ca3af;font-size:13px;width:60px;">Name</td><td style="color:#374151;font-size:13px;font-weight:500;">${esc(name)}</td></tr>
            <tr><td style="color:#9ca3af;font-size:13px;">Email</td><td style="color:#374151;font-size:13px;"><a href="mailto:${email}" style="color:#6366F1;text-decoration:none;">${email}</a></td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 32px;text-align:center;">
          <a href="${conversationId ? getReplyUrl(conversationId) : '#'}" style="display:inline-block;background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#ffffff;font-size:15px;font-weight:600;padding:12px 32px;border-radius:8px;text-decoration:none;box-shadow:0 2px 8px rgba(99,102,241,0.3);">Reply to ${esc(name)}</a>
        </td></tr>
        <tr><td style="padding:8px 32px 16px;border-top:1px solid #e5e7eb;text-align:center;">
          <p style="margin:0;color:#9ca3af;font-size:11px;">Click the button above to reply directly in the support chat.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ============================================
// ROUTES
// ============================================

// POST /api/support/conversations — Start a new conversation
router.post('/conversations', optionalAuth, supportLimiter, newConversationValidation, async (req, res) => {
  if (handleValidationErrors(req, res)) return;

  const { name, email, message, category } = req.body;
  const userId = req.user?.id || null;

  try {
    // Create conversation
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('support_conversations')
      .insert({
        user_id: userId,
        user_name: name,
        user_email: email,
        category,
      })
      .select()
      .single();

    if (convError) throw convError;

    // Create first message
    const { data: msg, error: msgError } = await supabaseAdmin
      .from('support_messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'user',
        message,
        is_read: true, // user's own message is always read
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // Send email to admin
    try {
      const resend = getResend();
      const timestamp = new Date().toLocaleString('en-US', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
      }) + ' UTC';

      await resend.emails.send({
        from: getFromEmail(conversation.id),
        to: getSupportEmail(),
        replyTo: getFromEmail(conversation.id).match(/<(.+)>/)?.[1] || `support+${conversation.id}@configure.news`,
        subject: `[${category}] Conversation with ${name}`,
        html: buildConversationEmailHtml({ name, email, message, category, timestamp, conversationHistory: [], conversationId: conversation.id }),
      });
    } catch (emailErr) {
      console.error('[SUPPORT] Email send failed (conversation still created):', emailErr.message);
    }

    console.log(`[SUPPORT] New conversation ${conversation.id} from ${email} — ${category}`);
    res.json({ conversation: { ...conversation, messages: [msg] } });
  } catch (err) {
    console.error('[SUPPORT] Failed to create conversation:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

// GET /api/support/conversations — List user's conversations
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    // Get conversations with latest message preview
    const { data: conversations, error } = await supabaseAdmin
      .from('support_conversations')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    // For each conversation, get the latest message and unread count
    const enriched = await Promise.all((conversations || []).map(async (conv) => {
      const { data: lastMsg } = await supabaseAdmin
        .from('support_messages')
        .select('message, sender_type, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const { count } = await supabaseAdmin
        .from('support_messages')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', conv.id)
        .eq('sender_type', 'support')
        .eq('is_read', false);

      return {
        ...conv,
        last_message: lastMsg || null,
        unread_count: count || 0,
      };
    }));

    res.json({ conversations: enriched });
  } catch (err) {
    console.error('[SUPPORT] Failed to fetch conversations:', err);
    res.status(500).json({ error: 'Failed to load conversations.' });
  }
});

// GET /api/support/conversations/unread — Check for any unread messages (lightweight)
router.get('/conversations/unread', authenticateToken, async (req, res) => {
  try {
    const { count, error } = await supabaseAdmin
      .from('support_messages')
      .select('*, support_conversations!inner(user_id)', { count: 'exact', head: true })
      .eq('support_conversations.user_id', req.user.id)
      .eq('sender_type', 'support')
      .eq('is_read', false);

    if (error) throw error;
    res.json({ unread: count || 0 });
  } catch (err) {
    console.error('[SUPPORT] Failed to check unread:', err);
    res.json({ unread: 0 });
  }
});

// GET /api/support/conversations/:id/messages — Get messages for a conversation
router.get('/conversations/:id/messages', authenticateToken, async (req, res) => {
  const conversationId = req.params.id;
  const after = req.query.after; // ISO timestamp for polling

  try {
    // Verify ownership
    const { data: conv, error: convError } = await supabaseAdmin
      .from('support_conversations')
      .select('id, user_id')
      .eq('id', conversationId)
      .eq('user_id', req.user.id)
      .single();

    if (convError || !conv) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    // Fetch messages (optionally after a timestamp)
    let msgQuery = supabaseAdmin
      .from('support_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (after) {
      msgQuery = msgQuery.gt('created_at', after);
    }

    const { data: messages, error: msgError } = await msgQuery;
    if (msgError) throw msgError;

    // Mark support messages as read
    if (messages && messages.some(m => m.sender_type === 'support' && !m.is_read)) {
      await supabaseAdmin
        .from('support_messages')
        .update({ is_read: true })
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'support')
        .eq('is_read', false);
    }

    res.json({ messages: messages || [] });
  } catch (err) {
    console.error('[SUPPORT] Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

// POST /api/support/conversations/:id/messages — Send follow-up message
router.post('/conversations/:id/messages', authenticateToken, supportLimiter, followUpValidation, async (req, res) => {
  if (handleValidationErrors(req, res)) return;

  const conversationId = req.params.id;
  const { message } = req.body;

  try {
    // Verify ownership and get conversation details
    const { data: conv, error: convError } = await supabaseAdmin
      .from('support_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('user_id', req.user.id)
      .single();

    if (convError || !conv) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    if (conv.status === 'closed') {
      return res.status(400).json({ error: 'This conversation has been closed.' });
    }

    // Insert message
    const { data: msg, error: msgError } = await supabaseAdmin
      .from('support_messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'user',
        message,
        is_read: true,
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // Update conversation timestamp
    await supabaseAdmin
      .from('support_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    // Get recent history for email context
    const { data: history } = await supabaseAdmin
      .from('support_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(10);

    // Send email notification to admin
    try {
      const resend = getResend();
      const timestamp = new Date().toLocaleString('en-US', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
      }) + ' UTC';

      // Remove the latest message from history (it's the main message in the email)
      const conversationHistory = (history || []).filter(m => m.id !== msg.id);

      await resend.emails.send({
        from: getFromEmail(conversationId),
        to: getSupportEmail(),
        replyTo: getFromEmail(conversationId).match(/<(.+)>/)?.[1] || `support+${conversationId}@configure.news`,
        subject: `Re: [${conv.category}] Conversation with ${conv.user_name}`,
        html: buildConversationEmailHtml({
          name: conv.user_name,
          email: conv.user_email,
          message,
          category: conv.category,
          timestamp,
          conversationHistory,
          conversationId,
        }),
      });
    } catch (emailErr) {
      console.error('[SUPPORT] Follow-up email failed:', emailErr.message);
    }

    res.json({ message: msg });
  } catch (err) {
    console.error('[SUPPORT] Failed to send follow-up:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

// ============================================
// ADMIN REPLY PAGE (web-based, HMAC-authenticated)
// ============================================

// GET /api/support/reply/:id — Render admin reply page
router.get('/reply/:id', async (req, res) => {
  const conversationId = req.params.id;
  const token = req.query.token;

  // Validate UUID format
  if (!/^[a-f0-9-]{36}$/i.test(conversationId)) {
    return res.status(400).send(buildErrorPage('Invalid conversation link.'));
  }

  // Verify HMAC token
  try {
    if (!verifyReplyToken(conversationId, token)) {
      return res.status(403).send(buildErrorPage('Invalid or expired reply link.'));
    }
  } catch {
    return res.status(403).send(buildErrorPage('Invalid or expired reply link.'));
  }

  try {
    // Fetch conversation
    const { data: conv, error: convError } = await supabaseAdmin
      .from('support_conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (convError || !conv) {
      return res.status(404).send(buildErrorPage('Conversation not found.'));
    }

    // Fetch messages
    const { data: messages } = await supabaseAdmin
      .from('support_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    res.send(buildReplyPage(conv, messages || [], token));
  } catch (err) {
    console.error('[SUPPORT] Reply page error:', err);
    res.status(500).send(buildErrorPage('Something went wrong. Please try again.'));
  }
});

// POST /api/support/reply/:id — Submit admin reply
router.post('/reply/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const conversationId = req.params.id;
  const token = req.body.token;
  const message = (req.body.message || '').trim();

  // Validate UUID
  if (!/^[a-f0-9-]{36}$/i.test(conversationId)) {
    return res.status(400).send(buildErrorPage('Invalid conversation link.'));
  }

  // Verify HMAC token
  try {
    if (!verifyReplyToken(conversationId, token)) {
      return res.status(403).send(buildErrorPage('Invalid or expired reply link.'));
    }
  } catch {
    return res.status(403).send(buildErrorPage('Invalid or expired reply link.'));
  }

  // Validate message
  if (!message || message.length > 5000) {
    return res.status(400).send(buildErrorPage('Reply must be between 1 and 5000 characters.'));
  }

  try {
    // Verify conversation exists
    const { data: conv, error: convError } = await supabaseAdmin
      .from('support_conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (convError || !conv) {
      return res.status(404).send(buildErrorPage('Conversation not found.'));
    }

    // Insert admin reply
    const { error: insertError } = await supabaseAdmin
      .from('support_messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'support',
        message,
        is_read: false,
      });

    if (insertError) throw insertError;

    // Update conversation timestamp and reopen if closed
    await supabaseAdmin
      .from('support_conversations')
      .update({ updated_at: new Date().toISOString(), status: 'open' })
      .eq('id', conversationId);

    console.log(`[SUPPORT] Admin reply stored for conversation ${conversationId} (${message.length} chars)`);

    // Redirect back to the reply page with success indicator
    const replyUrl = `/api/support/reply/${conversationId}?token=${token}&sent=1`;
    res.redirect(303, replyUrl);
  } catch (err) {
    console.error('[SUPPORT] Admin reply error:', err);
    res.status(500).send(buildErrorPage('Failed to send reply. Please try again.'));
  }
});

// ============================================
// REPLY PAGE HTML BUILDERS
// ============================================

function buildErrorPage(errorMessage) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Support Reply — News Agent</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
  .card{background:#fff;border-radius:12px;padding:40px 32px;max-width:480px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
  .card h1{font-size:20px;color:#374151;margin-bottom:8px}
  .card p{color:#6b7280;font-size:14px;line-height:1.5}
  .icon{font-size:48px;margin-bottom:16px}
</style></head><body>
<div class="card">
  <div class="icon">&#9888;&#65039;</div>
  <h1>Oops</h1>
  <p>${errorMessage}</p>
</div>
</body></html>`;
}

function buildReplyPage(conversation, messages, token) {
  const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const badgeColor = CATEGORY_COLORS[conversation.category] || '#6366F1';

  const messagesHtml = messages.map(msg => {
    const isUser = msg.sender_type === 'user';
    const align = isUser ? 'flex-start' : 'flex-end';
    const bgColor = isUser ? '#f3f4f6' : '#ede9fe';
    const borderColor = isUser ? '#e5e7eb' : '#c4b5fd';
    const label = isUser ? esc(conversation.user_name) : 'You (Support)';
    const labelColor = isUser ? '#6366F1' : '#059669';
    const time = new Date(msg.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });
    return `
      <div style="display:flex;justify-content:${align};margin-bottom:12px;">
        <div style="max-width:80%;background:${bgColor};border:1px solid ${borderColor};border-radius:12px;padding:10px 14px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="color:${labelColor};font-size:11px;font-weight:600;">${label}</span>
            <span style="color:#9ca3af;font-size:10px;">${time} UTC</span>
          </div>
          <p style="margin:0;color:#374151;font-size:13px;line-height:1.5;white-space:pre-wrap;">${esc(msg.message)}</p>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reply to ${esc(conversation.user_name)} — News Agent Support</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f7;min-height:100vh;padding:16px}
  .container{max-width:640px;margin:0 auto}
  .header{background:linear-gradient(135deg,#6366F1,#8B5CF6);border-radius:12px 12px 0 0;padding:24px 28px;color:#fff}
  .header h1{font-size:20px;font-weight:700;margin-bottom:4px}
  .header p{font-size:13px;color:rgba(255,255,255,0.85)}
  .meta{background:#fff;padding:16px 28px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .badge{display:inline-block;background:${badgeColor};color:#fff;font-size:11px;font-weight:600;padding:3px 10px;border-radius:16px}
  .meta-info{color:#6b7280;font-size:12px}
  .messages{background:#fff;padding:20px 28px;max-height:500px;overflow-y:auto}
  .reply-form{background:#fff;border-radius:0 0 12px 12px;padding:20px 28px;border-top:1px solid #e5e7eb}
  .reply-form textarea{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:12px;font-size:14px;font-family:inherit;resize:vertical;min-height:100px;outline:none;transition:border-color 0.2s}
  .reply-form textarea:focus{border-color:#6366F1;box-shadow:0 0 0 3px rgba(99,102,241,0.1)}
  .reply-form button{margin-top:12px;background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#fff;border:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:transform 0.1s,box-shadow 0.2s}
  .reply-form button:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(99,102,241,0.3)}
  .reply-form button:active{transform:translateY(0)}
  .success-banner{background:#059669;color:#fff;padding:12px 28px;font-size:14px;font-weight:500;text-align:center;display:none}
  .success-banner.show{display:block}
  .empty{color:#9ca3af;font-size:13px;text-align:center;padding:20px 0}
  @media(max-width:480px){
    .header{padding:20px 20px}
    .meta,.messages,.reply-form{padding-left:20px;padding-right:20px}
    .messages{max-height:350px}
  }
</style></head><body>
<div class="container">
  <div class="header">
    <h1>News Agent Support</h1>
    <p>Conversation with ${esc(conversation.user_name)} &mdash; ${esc(conversation.user_email)}</p>
  </div>
  <div class="success-banner" id="successBanner">Your reply has been sent successfully!</div>
  <div class="meta">
    <span class="badge">${esc(conversation.category)}</span>
    <span class="meta-info">Status: ${conversation.status === 'open' ? 'Open' : 'Closed'}</span>
    <span class="meta-info">Started: ${new Date(conversation.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</span>
  </div>
  <div class="messages" id="messagesContainer">
    ${messages.length > 0 ? messagesHtml : '<p class="empty">No messages yet.</p>'}
  </div>
  <div class="reply-form">
    <form method="POST" action="/api/support/reply/${conversation.id}">
      <input type="hidden" name="token" value="${esc(token)}">
      <textarea name="message" placeholder="Type your reply to ${esc(conversation.user_name)}..." required minlength="1" maxlength="5000" autofocus></textarea>
      <button type="submit">Send Reply</button>
    </form>
  </div>
</div>
<script>
  // Auto-scroll messages to bottom
  const mc = document.getElementById('messagesContainer');
  if (mc) mc.scrollTop = mc.scrollHeight;

  // Show success banner if redirected after sending
  if (new URLSearchParams(window.location.search).get('sent') === '1') {
    document.getElementById('successBanner').classList.add('show');
    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('sent');
    window.history.replaceState({}, '', url);
    // Auto-hide after 4s
    setTimeout(() => document.getElementById('successBanner').classList.remove('show'), 4000);
  }
</script>
</body></html>`;
}

export default router;
