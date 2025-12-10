// routes/auth.js
// SECURITY: Google OAuth only - manual login/registration removed for security
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import passport from 'passport';
import { createUser, getUserByEmail, updateUser } from '../services/database-wrapper.js';
import { generateToken } from '../middleware/auth.js';

const router = express.Router();

// Google OAuth routes - the ONLY authentication method
router.get('/google', (req, res, next) => {
  console.log('[AUTH] Google OAuth initiated');
  console.log('[AUTH] Google Client ID configured:', !!process.env.GOOGLE_CLIENT_ID);

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('[AUTH] Google OAuth not configured');
    return res.redirect('/auth.html?error=oauth_not_configured');
  }

  // Normal OAuth flow
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'  // Always show account selector
  })(req, res, next);
});

router.get('/google/callback', async (req, res, next) => {
  // Normal OAuth callback
  passport.authenticate('google', { failureRedirect: '/auth.html?error=auth_failed' })(req, res, async () => {
    try {
      // Generate JWT token for the authenticated user
      const token = generateToken(req.user.id);

      // Update last login
      await updateUser(req.user.id, { lastLogin: new Date() });

      // SECURITY: Set httpOnly cookie with the token
      res.cookie('authToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/'
      });

      // Redirect to profile page (token also in URL for backwards compatibility during migration)
      res.redirect(`/profile.html?token=${token}`);
    } catch (error) {
      console.error('[AUTH] Callback error:', error);
      res.redirect('/auth.html?error=callback_failed');
    }
  });
});

// Logout route
router.post('/logout', (req, res) => {
  // Clear the httpOnly auth cookie
  res.clearCookie('authToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });

  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ message: 'Logout successful' });
  });
});

// Session check endpoint - used by frontend to verify authentication status
router.get('/session', (req, res) => {
  if (req.user) {
    res.json({ authenticated: true, user: { id: req.user.id, email: req.user.email } });
  } else {
    res.json({ authenticated: false });
  }
});

export default router;
