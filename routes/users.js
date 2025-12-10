// routes/users.js
import express from 'express';
import { updateUser, getUserById } from '../services/database-wrapper.js';
// SECURITY: Input validation
import { profileUpdateValidation, settingsUpdateValidation, accountDeleteValidation } from '../utils/validators.js';

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
router.put('/profile', profileUpdateValidation, async (req, res) => {
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

// SECURITY: Password change removed - using Google OAuth only

// Get API key (masked for security - full key only shown on regeneration)
router.get('/api-key', async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    // SECURITY: Mask API key - show only first 8 and last 4 characters
    const maskedKey = apiKey
      ? `${apiKey.substring(0, 8)}...${apiKey.slice(-4)}`
      : null;

    res.json({
      apiKey: maskedKey,
      hint: 'Full key shown only on regeneration. Regenerate if you need the full key.',
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

// Get user settings (for settings page)
router.get('/settings', async (req, res) => {
  try {
    const user = await getUserById(req.user.id);

    // Return settings in format expected by frontend
    const settings = {
      topics: user.settings?.preferredTopics || user.automation?.topics || [],
      keywords: user.settings?.keywords || [],
      geoFilter: {
        region: user.settings?.geoFilter?.region || '',
        includeGlobal: user.settings?.geoFilter?.includeGlobal !== false // Default to true
      },
      schedule: {
        postsPerDay: user.automation?.postsPerDay || 1,
        startTime: user.settings?.schedule?.startTime || '09:00',
        endTime: user.settings?.schedule?.endTime || '21:00'
      },
      contentStyle: {
        tone: user.automation?.tone || 'professional',
        includeHashtags: user.settings?.contentStyle?.includeHashtags !== false
      },
      platforms: user.settings?.defaultPlatforms || user.automation?.platforms || []
    };

    res.json(settings);
  } catch (error) {
    console.error('Settings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update user settings (for settings page)
router.put('/settings', settingsUpdateValidation, async (req, res) => {
  try {
    const { topics, keywords, geoFilter, schedule, contentStyle, platforms } = req.body;

    // Validate keywords (must be array of strings, max 10)
    const validatedKeywords = Array.isArray(keywords)
      ? keywords.filter(k => typeof k === 'string' && k.trim().length > 0).slice(0, 10) // Max 10 keywords
      : [];

    // Validate geoFilter
    const validatedGeoFilter = {
      region: typeof geoFilter?.region === 'string' ? geoFilter.region : '',
      includeGlobal: geoFilter?.includeGlobal !== false
    };

    // Map frontend settings to database structure
    const updates = {
      settings: {
        preferredTopics: topics || [],
        keywords: validatedKeywords,
        geoFilter: validatedGeoFilter,
        defaultPlatforms: platforms || [],
        autoSchedule: true,
        schedule: {
          startTime: schedule?.startTime || '09:00',
          endTime: schedule?.endTime || '21:00'
        },
        contentStyle: {
          tone: contentStyle?.tone || 'professional',
          includeHashtags: contentStyle?.includeHashtags !== false
        }
      },
      automation: {
        enabled: true,
        topics: topics || [],
        keywords: validatedKeywords,
        geoFilter: validatedGeoFilter,
        platforms: platforms || [],
        postsPerDay: parseInt(schedule?.postsPerDay) || 1,
        tone: contentStyle?.tone || 'professional',
        schedule: {
          morning: true,
          lunch: true,
          evening: true,
          night: false
        }
      }
    };

    await updateUser(req.user.id, updates);

    res.json({
      message: 'Settings saved successfully',
      settings: req.body
    });
  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({ error: 'Failed to save settings' });
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
router.delete('/account', accountDeleteValidation, async (req, res) => {
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