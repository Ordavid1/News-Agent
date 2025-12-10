// routes/automation.js
import express from 'express';
import { updateUser, getUserById } from '../services/database-wrapper.js';

const router = express.Router();

// Get current automation settings
router.get('/settings', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId);
    
    res.json({
      automation: user.automation || {
        enabled: false,
        platforms: [],
        topics: [],
        postsPerDay: 1,
        schedule: {
          morning: false,
          lunch: false,
          evening: false,
          night: false
        },
        tone: 'professional'
      }
    });
  } catch (error) {
    console.error('Error fetching automation settings:', error);
    res.status(500).json({ error: 'Failed to fetch automation settings' });
  }
});

// Update automation settings
router.put('/settings', async (req, res) => {
  try {
    const userId = req.user.id;
    const { enabled, platforms, topics, postsPerDay, schedule, tone } = req.body;
    
    // Validate settings
    if (postsPerDay > req.user.subscription.dailyLimit) {
      return res.status(400).json({ 
        error: `Posts per day cannot exceed your daily limit of ${req.user.subscription.dailyLimit}` 
      });
    }
    
    // Validate platforms based on tier
    const allowedPlatforms = getAllowedPlatforms(req.user.subscription.tier);
    const validPlatforms = platforms.filter(p => allowedPlatforms.includes(p));
    
    if (validPlatforms.length === 0 && enabled) {
      return res.status(400).json({ 
        error: 'No valid platforms selected for your subscription tier',
        allowedPlatforms 
      });
    }
    
    const automationSettings = {
      enabled,
      platforms: validPlatforms,
      topics,
      postsPerDay,
      schedule,
      tone: tone || 'professional'
    };
    
    // Update user automation settings
    await updateUser(userId, {
      automation: automationSettings
    });
    
    // Update automation manager
    const automationManager = req.app.locals.automationManager;
    if (automationManager) {
      await automationManager.updateUserAutomation(userId, automationSettings);
    }
    
    res.json({
      message: 'Automation settings updated successfully',
      automation: automationSettings
    });
    
  } catch (error) {
    console.error('Error updating automation settings:', error);
    res.status(500).json({ error: 'Failed to update automation settings' });
  }
});

// Pause automation
router.post('/pause', async (req, res) => {
  try {
    const userId = req.user.id;
    
    await updateUser(userId, {
      'automation.enabled': false
    });
    
    const automationManager = req.app.locals.automationManager;
    if (automationManager) {
      await automationManager.pauseUserAutomation(userId);
    }
    
    res.json({ message: 'Automation paused successfully' });
    
  } catch (error) {
    console.error('Error pausing automation:', error);
    res.status(500).json({ error: 'Failed to pause automation' });
  }
});

// Resume automation
router.post('/resume', async (req, res) => {
  try {
    const userId = req.user.id;
    
    await updateUser(userId, {
      'automation.enabled': true
    });
    
    const automationManager = req.app.locals.automationManager;
    if (automationManager) {
      await automationManager.resumeUserAutomation(userId);
    }
    
    res.json({ message: 'Automation resumed successfully' });
    
  } catch (error) {
    console.error('Error resuming automation:', error);
    res.status(500).json({ error: 'Failed to resume automation' });
  }
});

// Helper function to get allowed platforms by tier
// Note: Facebook is disabled until integration is set up
function getAllowedPlatforms(tier) {
  const platformsByTier = {
    free: ['linkedin', 'reddit', 'telegram'],
    starter: ['linkedin', 'reddit', 'telegram'],
    growth: ['twitter', 'linkedin', 'reddit', 'telegram'],
    professional: ['twitter', 'linkedin', 'reddit', 'telegram', 'instagram'],
    business: ['twitter', 'linkedin', 'reddit', 'telegram', 'instagram', 'tiktok', 'youtube']
  };

  return platformsByTier[tier] || ['linkedin', 'reddit', 'telegram'];
}

export default router;