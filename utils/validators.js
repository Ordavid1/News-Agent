// utils/validators.js
// SECURITY: Input validation schemas using express-validator
// Centralizes validation logic for reuse across routes

import { body, param, query, validationResult } from 'express-validator';

/**
 * Middleware to check validation results and return errors if any
 */
export function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.path,
        message: err.msg
      }))
    });
  }
  next();
}

// ============================================
// POST VALIDATION
// ============================================

export const postGenerateValidation = [
  body('topic')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Topic must be between 1 and 200 characters'),

  body('platforms')
    .optional()
    .isArray({ max: 10 })
    .withMessage('Platforms must be an array with max 10 items'),

  body('platforms.*')
    .optional()
    .isString()
    .isIn(['twitter', 'linkedin', 'reddit', 'facebook', 'telegram', 'instagram', 'tiktok', 'youtube'])
    .withMessage('Invalid platform'),

  body('tone')
    .optional()
    .isString()
    .isIn(['professional', 'casual', 'humorous', 'informative', 'engaging'])
    .withMessage('Invalid tone'),

  body('scheduleTime')
    .optional()
    .isISO8601()
    .withMessage('Schedule time must be a valid ISO 8601 date'),

  validate
];

export const bulkGenerateValidation = [
  body('topics')
    .isArray({ min: 1, max: 10 })
    .withMessage('Topics must be an array with 1-10 items'),

  body('topics.*')
    .isString()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Each topic must be between 1 and 200 characters'),

  body('platforms')
    .optional()
    .isArray({ max: 10 })
    .withMessage('Platforms must be an array'),

  validate
];

// ============================================
// USER VALIDATION
// ============================================

export const profileUpdateValidation = [
  body('name')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .escape()
    .withMessage('Name must be between 1 and 100 characters'),

  body('settings')
    .optional()
    .isObject()
    .withMessage('Settings must be an object'),

  validate
];

export const settingsUpdateValidation = [
  body('topics')
    .optional()
    .isArray({ max: 20 })
    .withMessage('Topics must be an array with max 20 items'),

  body('topics.*')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Each topic must be between 1 and 100 characters'),

  body('keywords')
    .optional()
    .isArray({ max: 10 })
    .withMessage('Keywords must be an array with max 10 items'),

  body('keywords.*')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Each keyword must be between 1 and 50 characters'),

  body('geoFilter.region')
    .optional()
    .isString()
    .isLength({ max: 50 })
    .withMessage('Region must be max 50 characters'),

  body('geoFilter.includeGlobal')
    .optional()
    .isBoolean()
    .withMessage('includeGlobal must be a boolean'),

  body('schedule.postsPerDay')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('Posts per day must be between 1 and 50'),

  body('schedule.startTime')
    .optional()
    .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Start time must be in HH:MM format'),

  body('schedule.endTime')
    .optional()
    .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('End time must be in HH:MM format'),

  body('contentStyle.tone')
    .optional()
    .isString()
    .isIn(['professional', 'casual', 'humorous', 'informative', 'engaging'])
    .withMessage('Invalid tone'),

  body('contentStyle.includeHashtags')
    .optional()
    .isBoolean()
    .withMessage('includeHashtags must be a boolean'),

  body('platforms')
    .optional()
    .isArray({ max: 10 })
    .withMessage('Platforms must be an array'),

  validate
];

export const accountDeleteValidation = [
  body('confirmEmail')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email to confirm deletion'),

  validate
];

// ============================================
// AGENT VALIDATION
// ============================================

export const agentCreateValidation = [
  body('connectionId')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Connection ID is required'),

  body('name')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Agent name must be between 1 and 100 characters'),

  body('settings')
    .optional()
    .isObject()
    .withMessage('Settings must be an object'),

  body('settings.topics')
    .optional()
    .isArray({ max: 20 })
    .withMessage('Topics must be an array with max 20 items'),

  body('settings.keywords')
    .optional()
    .isArray({ max: 10 })
    .withMessage('Keywords must be an array with max 10 items'),

  validate
];

export const agentUpdateValidation = [
  body('name')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Agent name must be between 1 and 100 characters'),

  body('settings')
    .optional()
    .isObject()
    .withMessage('Settings must be an object'),

  validate
];

export const agentStatusValidation = [
  body('status')
    .isString()
    .isIn(['active', 'paused'])
    .withMessage('Status must be "active" or "paused"'),

  validate
];

// ============================================
// SUBSCRIPTION VALIDATION
// ============================================

export const checkoutValidation = [
  body('tier')
    .isString()
    .isIn(['starter', 'growth', 'professional', 'business'])
    .withMessage('Invalid subscription tier'),

  validate
];

export const changePlanValidation = [
  body('tier')
    .isString()
    .isIn(['starter', 'growth', 'professional', 'business'])
    .withMessage('Invalid subscription tier'),

  validate
];

// ============================================
// COMMON PARAM VALIDATORS
// ============================================

export const uuidParam = (paramName) => [
  param(paramName)
    .isUUID()
    .withMessage(`${paramName} must be a valid UUID`),

  validate
];

export const idParam = (paramName) => [
  param(paramName)
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 100 })
    .withMessage(`${paramName} must be a valid ID`),

  validate
];

// ============================================
// QUERY VALIDATORS
// ============================================

export const paginationQuery = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .toInt()
    .withMessage('Limit must be between 1 and 100'),

  query('offset')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('Offset must be a non-negative integer'),

  validate
];

// ============================================
// DEMO VALIDATION
// ============================================

export const demoGenerateValidation = [
  body('topics')
    .isArray({ min: 1, max: 5 })
    .withMessage('Topics must be an array with 1-5 items'),

  body('topics.*')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Each topic must be between 1 and 100 characters'),

  body('platforms')
    .isArray({ min: 1, max: 5 })
    .withMessage('Platforms must be an array with 1-5 items'),

  body('platforms.*')
    .isString()
    .isIn(['twitter', 'linkedin', 'reddit', 'facebook', 'telegram'])
    .withMessage('Invalid platform'),

  validate
];

export default {
  validate,
  postGenerateValidation,
  bulkGenerateValidation,
  profileUpdateValidation,
  settingsUpdateValidation,
  accountDeleteValidation,
  agentCreateValidation,
  agentUpdateValidation,
  agentStatusValidation,
  checkoutValidation,
  changePlanValidation,
  uuidParam,
  idParam,
  paginationQuery,
  demoGenerateValidation
};
