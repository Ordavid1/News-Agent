/**
 * ArticleFingerprintService
 *
 * Generates story fingerprints for detecting duplicate news stories across different outlets.
 * Uses a combination of named entities, keywords, and date bucketing to identify
 * when the same news story is published by multiple sources.
 *
 * Fingerprint format: "date|entities|keywords"
 * Example: "2024-01-15|apple_iphone|announces_features_artificial"
 */

import crypto from 'crypto';

class ArticleFingerprintService {
  constructor() {
    // Common stopwords to exclude from fingerprint (words that don't help identify a story)
    this.stopwords = new Set([
      // Articles and prepositions
      'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'has',
      'will', 'would', 'could', 'should', 'about', 'after', 'before',
      'into', 'over', 'under', 'between', 'through', 'during', 'without',
      // News-specific stopwords
      'says', 'said', 'report', 'reports', 'news', 'breaking', 'update',
      'just', 'now', 'new', 'latest', 'today', 'yesterday', 'announces',
      'announced', 'according', 'sources', 'official', 'officials',
      'exclusive', 'developing', 'updated', 'live', 'watch', 'read',
      // Common verbs
      'make', 'made', 'take', 'took', 'come', 'came', 'give', 'gave',
      'find', 'found', 'know', 'knew', 'think', 'thought', 'tell', 'told',
      'become', 'became', 'show', 'showed', 'leave', 'left', 'call', 'called',
      // Time words
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      'january', 'february', 'march', 'april', 'may', 'june', 'july',
      'august', 'september', 'october', 'november', 'december',
      'week', 'month', 'year', 'day', 'hour', 'minute',
      // Quantities
      'first', 'second', 'third', 'million', 'billion', 'percent', 'more', 'most'
    ]);

    // Known multi-word entities that should be kept together
    this.knownEntities = new Set([
      'artificial intelligence', 'machine learning', 'deep learning',
      'united states', 'european union', 'united kingdom',
      'wall street', 'silicon valley', 'white house',
      'federal reserve', 'supreme court', 'world health organization'
    ]);
  }

  /**
   * Generate a story fingerprint from article data
   * @param {Object} article - Article with title, publishedAt, description
   * @returns {string} Fingerprint string for storage/comparison
   */
  generateFingerprint(article) {
    const title = article.title || '';
    const publishedAt = article.publishedAt;

    // 1. Get date bucket (YYYY-MM-DD)
    const dateBucket = this.getDateBucket(publishedAt);

    // 2. Extract named entities (proper nouns) from original title
    const entities = this.extractNamedEntities(title);

    // 3. Normalize title and extract significant keywords
    const normalized = this.normalizeText(title);
    const keywords = this.extractKeywords(normalized);

    // 4. Combine into fingerprint: date|entities|keywords
    // Limit entities to top 4 and keywords to top 8 to avoid over-specificity
    const entityPart = entities.slice(0, 4).join('_') || 'none';
    const keywordPart = keywords.slice(0, 8).join('_') || 'none';

    return `${dateBucket}|${entityPart}|${keywordPart}`;
  }

  /**
   * Normalize text for comparison
   * @param {string} text - Raw text
   * @returns {string} Normalized text
   */
  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/['']/g, "'")     // Normalize quotes
      .replace(/[""]/g, '"')     // Normalize double quotes
      .replace(/[^a-z0-9\s']/g, ' ')  // Remove punctuation except apostrophe
      .replace(/\s+/g, ' ')      // Normalize whitespace
      .trim();
  }

  /**
   * Extract significant keywords from normalized text
   * @param {string} normalized - Normalized text
   * @returns {string[]} Array of keywords, sorted alphabetically
   */
  extractKeywords(normalized) {
    const words = normalized.split(/\s+/)
      .filter(w => w.length > 3)                    // Words > 3 chars
      .filter(w => !this.stopwords.has(w))          // Not a stopword
      .filter(w => !/^\d+$/.test(w))                // Not purely numeric
      .filter(w => !/^'/.test(w) && !/'$/.test(w)); // Not starting/ending with apostrophe

    // Dedupe and sort for consistent ordering
    return [...new Set(words)].sort();
  }

  /**
   * Get date bucket from publishedAt
   * @param {string|Date} publishedAt - Article publish date
   * @returns {string} Date in YYYY-MM-DD format
   */
  getDateBucket(publishedAt) {
    if (!publishedAt) {
      // Default to today if no date
      return new Date().toISOString().split('T')[0];
    }

    const date = new Date(publishedAt);
    if (isNaN(date.getTime())) {
      return new Date().toISOString().split('T')[0];
    }

    return date.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * Extract named entities (proper nouns) from title
   * These are key identifiers like "Apple", "OpenAI", "Biden"
   * @param {string} title - Original title (preserving case)
   * @returns {string[]} Array of entity names, lowercase
   */
  extractNamedEntities(title) {
    // First, check for known multi-word entities
    const foundKnown = [];
    const titleLower = title.toLowerCase();
    for (const entity of this.knownEntities) {
      if (titleLower.includes(entity)) {
        foundKnown.push(entity.replace(/\s+/g, ''));
      }
    }

    // Match capitalized words (potential proper nouns)
    // This regex matches: "Apple", "OpenAI", "GPT-4", "iPhone", "Biden"
    const matches = title.match(/\b[A-Z][a-zA-Z0-9-]*(?:\s+[A-Z][a-zA-Z0-9-]*)*/g) || [];

    // Normalize and dedupe
    const entities = matches
      .map(m => m.toLowerCase().replace(/\s+/g, ''))
      .filter(e => e.length > 2)                     // At least 3 chars
      .filter(e => !this.stopwords.has(e))           // Not a stopword
      .filter(e => !/^\d+$/.test(e));                // Not purely numeric

    // Combine known entities with detected ones, dedupe
    const combined = [...new Set([...foundKnown, ...entities])];

    return combined;
  }

  /**
   * Generate URL hash for exact matching
   * @param {string} url - Article URL
   * @returns {string} MD5 hash of normalized URL
   */
  generateUrlHash(url) {
    // Normalize URL: lowercase, remove protocol, trailing slash, query params
    const normalized = url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .replace(/[?#].*$/, ''); // Remove query params and fragments

    // Use MD5 for fast hashing (collision resistance not critical here)
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Check if two fingerprints represent the same story
   * Uses flexible matching with entity and keyword overlap
   * @param {string} fp1 - First fingerprint
   * @param {string} fp2 - Second fingerprint
   * @param {Object} options - Matching options
   * @returns {boolean} Whether they match
   */
  fingerprintsMatch(fp1, fp2, options = {}) {
    const {
      entityOverlapThreshold = 0.6,   // 60% entity overlap
      keywordOverlapThreshold = 0.5,  // 50% keyword overlap
      maxDateDiffDays = 1             // Same day or adjacent day
    } = options;

    if (fp1 === fp2) return true;

    const [date1, entities1, keywords1] = fp1.split('|');
    const [date2, entities2, keywords2] = fp2.split('|');

    // Date must be within maxDateDiffDays
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const dayDiff = Math.abs(d1 - d2) / (1000 * 60 * 60 * 24);
    if (dayDiff > maxDateDiffDays) return false;

    // Calculate entity overlap
    const entitySet1 = new Set(entities1.split('_').filter(e => e && e !== 'none'));
    const entitySet2 = new Set(entities2.split('_').filter(e => e && e !== 'none'));
    const entityOverlap = this.calculateOverlap(entitySet1, entitySet2);

    // Calculate keyword overlap
    const keywordSet1 = new Set(keywords1.split('_').filter(k => k && k !== 'none'));
    const keywordSet2 = new Set(keywords2.split('_').filter(k => k && k !== 'none'));
    const keywordOverlap = this.calculateOverlap(keywordSet1, keywordSet2);

    // Match if: high entity overlap OR high keyword overlap
    // This catches "same story, different headline" cases
    return entityOverlap >= entityOverlapThreshold || keywordOverlap >= keywordOverlapThreshold;
  }

  /**
   * Calculate Jaccard-like overlap between two sets
   * Uses min(set1, set2) as denominator for better handling of asymmetric sets
   * @param {Set} set1 - First set
   * @param {Set} set2 - Second set
   * @returns {number} Overlap ratio (0-1)
   */
  calculateOverlap(set1, set2) {
    if (set1.size === 0 && set2.size === 0) return 1;
    if (set1.size === 0 || set2.size === 0) return 0;

    let common = 0;
    for (const item of set1) {
      if (set2.has(item)) common++;
    }

    // Use min size as denominator - this means if 3/3 entities match, it's 100%
    // even if the other fingerprint has more entities
    return common / Math.min(set1.size, set2.size);
  }

  /**
   * Debug helper: analyze a fingerprint
   * @param {string} fingerprint - Fingerprint to analyze
   * @returns {Object} Parsed fingerprint components
   */
  analyzeFingerprint(fingerprint) {
    const [date, entities, keywords] = fingerprint.split('|');
    return {
      date,
      entities: entities.split('_').filter(e => e && e !== 'none'),
      keywords: keywords.split('_').filter(k => k && k !== 'none'),
      raw: fingerprint
    };
  }
}

export default ArticleFingerprintService;
