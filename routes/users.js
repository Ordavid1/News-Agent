// routes/users.js
import express from 'express';
import bcrypt from 'bcryptjs';
import { updateUser, getUserById } from '../services/database-wrapper.js';

const router = express.Router();

// Get current user profile
router.get('/profile', async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    
    // Remove sensitive fields
    delete user.password;
    delete user.passwordResetToken;
    delete user.passwordResetExpiry;
    
    res.json({ user });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update user profile
router.put('/profile', async (req, res) => {
  try {
    const { name, settings } = req.body;
    const updates = {};
    
    if (name) updates.name = name;
    if (settings) {
      updates.settings = {
        ...req.user.settings,
        ...settings
      };
    }
    
    await updateUser(req.user.id, updates);
    
    res.json({ 
      message: 'Profile updated successfully',
      updates 
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update password
router.put('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        error: 'Current password and new password are required' 
      });
    }
    
    // Verify current password
    const user = await getUserById(req.user.id);
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await updateUser(req.user.id, { password: hashedPassword });
    
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Password update error:', error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// Get API key
router.get('/api-key', async (req, res) => {
  try {
    res.json({ 
      apiKey: req.user.apiKey,
      usage: 'Add to request headers as: X-API-Key' 
    });
  } catch (error) {
    console.error('API key fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch API key' });
  }
});

// Regenerate API key
router.post('/api-key/regenerate', async (req, res) => {
  try {
    const { v4: uuidv4 } = await import('uuid');
    const newApiKey = uuidv4();
    
    await updateUser(req.user.id, { apiKey: newApiKey });
    
    res.json({ 
      message: 'API key regenerated successfully',
      apiKey: newApiKey 
    });
  } catch (error) {
    console.error('API key regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate API key' });
  }
});

// Update user preferences
router.put('/preferences', async (req, res) => {
  try {
    const { 
      defaultPlatforms, 
      preferredTopics, 
      autoSchedule,
      timezone,
      notificationSettings 
    } = req.body;
    
    const settings = { ...req.user.settings };
    
    if (defaultPlatforms) settings.defaultPlatforms = defaultPlatforms;
    if (preferredTopics) settings.preferredTopics = preferredTopics;
    if (typeof autoSchedule === 'boolean') settings.autoSchedule = autoSchedule;
    if (timezone) settings.timezone = timezone;
    if (notificationSettings) settings.notificationSettings = notificationSettings;
    
    await updateUser(req.user.id, { settings });
    
    res.json({ 
      message: 'Preferences updated successfully',
      settings 
    });
  } catch (error) {
    console.error('Preferences update error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Delete account (soft delete)
router.delete('/account', async (req, res) => {
  try {
    const { confirmEmail } = req.body;
    
    if (confirmEmail !== req.user.email) {
      return res.status(400).json({ 
        error: 'Please confirm your email address to delete account' 
      });
    }
    
    // Soft delete - mark account as deleted but keep data
    await updateUser(req.user.id, {
      deletedAt: new Date(),
      status: 'deleted'
    });
    
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Account deletion error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;