// routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import passport from 'passport';
import { createUser, getUserByEmail, getUserByResetToken, updateUser } from '../services/database-wrapper.js';
import { generateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Register new user
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    // Validate input
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    
    // Check if user already exists
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const user = await createUser({
      email,
      password: hashedPassword,
      name,
      apiKey: uuidv4(),
      role: 'user'
    });
    
    // Generate token
    const token = generateToken(user.id);
    
    // Remove password from response
    delete user.password;
    
    res.status(201).json({
      message: 'User created successfully',
      user,
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('Login attempt:', { email, testMode: process.env.TEST_MODE });
    
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Test mode: accept any login with password "test123"
    if (process.env.TEST_MODE === 'true' && password === 'test123') {
      console.log('Test mode login for:', email);
      let user = await getUserByEmail(email);
      
      if (!user) {
        console.log('Creating new test user:', email);
        // Create test user with provided email
        user = await createUser({
          email,
          password: await bcrypt.hash('test123', 10),
          name: email.split('@')[0],
          apiKey: uuidv4(),
          role: 'user'
        });
      }
      
      // Generate token
      const token = generateToken(user.id);
      console.log('Token generated for user:', user.id);
      
      // Remove password from response
      delete user.password;
      
      return res.json({
        message: 'Login successful (TEST MODE)',
        user,
        token
      });
    }
    
    // Normal login flow
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Update last login
    await updateUser(user.id, { lastLogin: new Date() });
    
    // Generate token
    const token = generateToken(user.id);
    
    // Remove password from response
    delete user.password;
    
    res.json({
      message: 'Login successful',
      user,
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Reset password request
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await getUserByEmail(email);
    if (!user) {
      // Don't reveal if user exists
      return res.json({ message: 'If an account exists, a password reset link has been sent' });
    }
    
    // Generate reset token
    const resetToken = uuidv4();
    const resetExpiry = new Date();
    resetExpiry.setHours(resetExpiry.getHours() + 1); // 1 hour expiry
    
    await updateUser(user.id, {
      passwordResetToken: resetToken,
      passwordResetExpiry: resetExpiry
    });
    
    // TODO: Send email with reset link
    // For now, return token (remove in production)
    res.json({ 
      message: 'Password reset link sent',
      resetToken: process.env.NODE_ENV === 'development' ? resetToken : undefined
    });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to process password reset' });
  }
});

// Reset password
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    
    // Find user with valid reset token
    const users = await getUserByResetToken(token);
    if (!users || users.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
    const user = users[0];
    
    // Check if token is expired
    if (new Date() > new Date(user.passwordResetExpiry)) {
      return res.status(400).json({ error: 'Reset token has expired' });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password and clear reset token
    await updateUser(user.id, {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null
    });
    
    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Google OAuth routes
router.get('/google', async (req, res) => {
  console.log('Google OAuth route hit, test mode:', process.env.TEST_MODE);
  
  // Test mode: skip OAuth and create/login test user
  if (process.env.TEST_MODE === 'true') {
    try {
      const testEmail = 'test@example.com';
      console.log('Test mode Google login, creating/fetching user:', testEmail);
      let user = await getUserByEmail(testEmail);
      
      if (!user) {
        console.log('Creating new Google test user');
        // Create test user
        user = await createUser({
          email: testEmail,
          name: 'Test User',
          googleId: 'test-google-id',
          apiKey: uuidv4(),
          role: 'user',
          authProvider: 'google'
        });
      }
      
      // Generate token
      const token = generateToken(user.id);
      console.log('Token generated, redirecting with token');
      
      // Redirect with token
      res.redirect(`/auth.html?token=${token}`);
    } catch (error) {
      console.error('Test auth error:', error);
      res.redirect('/auth.html?error=auth_failed');
    }
  } else {
    // Normal OAuth flow
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res);
  }
});

router.get('/google/callback', async (req, res, next) => {
  // In test mode, skip passport authentication
  if (process.env.TEST_MODE === 'true') {
    return res.redirect('/auth.html?error=test_mode_active');
  }
  
  // Normal OAuth callback
  passport.authenticate('google', { failureRedirect: '/auth.html' })(req, res, async () => {
    // Generate JWT token for the authenticated user
    const token = generateToken(req.user.id);
    
    // Redirect to profile page with token
    res.redirect(`/profile.html?token=${token}`);
  });
});

// Logout route
router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ message: 'Logout successful' });
  });
});

export default router;