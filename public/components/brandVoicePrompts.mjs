// brandVoicePrompts.mjs
// Prompts for Brand Voice analysis and original content generation.
// Used by BrandVoiceService to (1) analyze collected posts into a brand voice profile,
// and (2) generate new posts that match that profile.

import { isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Platform display names and character limits for generation prompts
 */
const PLATFORM_CONSTRAINTS = {
  twitter: { name: 'Twitter/X', charLimit: 280, notes: 'Include 2-3 relevant hashtags. Concise and punchy.' },
  linkedin: { name: 'LinkedIn', charLimit: 3000, notes: 'Professional tone. 3-4 paragraphs. Can include hashtags at end.' },
  facebook: { name: 'Facebook', charLimit: 5000, notes: 'Conversational and shareable. First 2-3 lines visible before "See more". 5-7 hashtags at end.' },
  instagram: { name: 'Instagram', charLimit: 2200, notes: 'Strong hook in first line. 15-20 hashtags separated by dots at end. Complements visual content.' },
  reddit: { name: 'Reddit', charLimit: 40000, notes: 'Authentic and discussion-provoking. No emojis. Community-oriented.' },
  telegram: { name: 'Telegram', charLimit: 4096, notes: 'News-focused and informative. HTML formatting supported.' },
  threads: { name: 'Threads', charLimit: 500, notes: 'Conversational and concise. Discussion-provoking.' },
  whatsapp: { name: 'WhatsApp', charLimit: 4096, notes: 'Direct and personal tone. Suitable for group sharing.' },
  tiktok: { name: 'TikTok', charLimit: 500, notes: 'Scroll-stopping hook. Short line breaks. 3-5 CamelCase hashtags. NO URLs.' }
};

/**
 * System prompt for analyzing collected posts and extracting a brand voice profile.
 * This is the "training" step — the LLM reads all posts and produces a structured JSON profile.
 */
export function getBrandVoiceAnalysisSystemPrompt() {
  return `You are an expert brand strategist and linguist specializing in social media voice analysis. Your task is to deeply analyze a collection of social media posts from a brand and extract a comprehensive, structured brand voice profile.

IMPORTANT INSTRUCTIONS:
- Analyze ALL provided posts holistically, not individually
- Identify PATTERNS that recur across multiple posts
- Distinguish between intentional style choices and one-off variations
- Be specific and descriptive — avoid vague descriptors like "good" or "nice"
- Include actual phrases, words, and patterns from the posts as examples
- If posts span multiple platforms, note platform-specific adaptations

You MUST respond with ONLY valid JSON (no markdown code fences, no extra text). The JSON must conform to the schema described in the user prompt.`;
}

/**
 * User prompt for brand voice analysis — includes the posts and the expected output schema.
 * @param {Array} posts - Collected posts grouped by platform
 * @param {Object} stats - Collection statistics
 */
export function getBrandVoiceAnalysisUserPrompt(posts, stats) {
  const platformSections = Object.entries(posts)
    .map(([platform, platformPosts]) => {
      const postTexts = platformPosts
        .filter(p => p.content && p.content.trim().length > 0)
        .map((p, i) => `[${i + 1}] ${p.content}`)
        .join('\n\n');
      return `=== ${platform.toUpperCase()} POSTS (${platformPosts.length} posts) ===\n${postTexts}`;
    })
    .join('\n\n');

  return `Analyze the following ${stats.totalPosts} social media posts from a brand (across ${stats.platformCount} platform${stats.platformCount > 1 ? 's' : ''}) and produce a comprehensive brand voice profile.

${platformSections}

Produce a JSON object with this exact structure:

{
  "overall_tone": "Description of the brand's general tone (e.g., 'professional yet approachable', 'bold and assertive')",
  "writing_style": {
    "sentence_length": "short / medium / long / mixed",
    "paragraph_structure": "Description of how they structure paragraphs",
    "formality_level": "formal / semi-formal / casual / very casual",
    "voice": "first person singular (I) / first person plural (we) / third person / mixed",
    "punctuation_habits": "Description of notable punctuation patterns (e.g., heavy use of exclamation marks, em dashes, ellipses)"
  },
  "vocabulary": {
    "common_phrases": ["List of 5-10 phrases or expressions the brand frequently uses"],
    "industry_terms": ["List of domain-specific terms they commonly use"],
    "power_words": ["List of impactful or emotional words they favor"],
    "avoided_patterns": ["Any patterns they seem to intentionally avoid"]
  },
  "content_themes": ["List of 3-7 recurring topics or themes"],
  "formatting": {
    "emoji_usage": "Description of how/when/which emojis are used",
    "hashtag_style": "Description of hashtag patterns (count, placement, branded vs generic)",
    "link_placement": "How and where links are typically placed",
    "list_style": "Whether they use bullet points, numbered lists, or flowing paragraphs",
    "call_to_action_style": "How they typically end posts or prompt engagement"
  },
  "language": "Primary language detected",
  "emotional_register": "Description of the emotional range (e.g., 'optimistic and forward-looking', 'urgent and concerned', 'inspirational and empowering')",
  "unique_characteristics": ["List of 2-5 distinctive quirks or signature elements that make this brand voice unique"],
  "platform_variations": {
    // Only include platforms that had posts analyzed
    "platform_name": {
      "tone_shift": "How the tone differs on this platform",
      "typical_length": "Typical post length range",
      "notable_differences": "Any platform-specific adaptations"
    }
  }
}

Respond with ONLY the JSON object, no other text.`;
}

/**
 * System prompt for merging partial analysis results (used when chunking large post sets).
 */
export function getBrandVoiceMergeSystemPrompt() {
  return `You are an expert brand strategist. You will receive multiple partial brand voice analysis results that were generated from different batches of a brand's social media posts. Your task is to merge these into a single, cohesive brand voice profile.

Rules:
- Consolidate overlapping observations — don't simply concatenate lists
- Prefer patterns that appear across multiple chunks (they're more reliable)
- Resolve any contradictions by favoring the more frequently observed pattern
- Keep list items deduplicated and ordered by relevance
- The output JSON schema must match the inputs exactly

Respond with ONLY valid JSON (no markdown code fences, no extra text).`;
}

/**
 * User prompt for merging chunked analysis results.
 * @param {Array} partialResults - Array of partial JSON analysis results
 */
export function getBrandVoiceMergeUserPrompt(partialResults) {
  const chunks = partialResults
    .map((r, i) => `=== ANALYSIS CHUNK ${i + 1} ===\n${JSON.stringify(r, null, 2)}`)
    .join('\n\n');

  return `Merge these ${partialResults.length} partial brand voice analyses into a single consolidated profile:\n\n${chunks}\n\nRespond with ONLY the merged JSON object.`;
}

/**
 * System prompt for generating original posts that match a brand voice profile.
 * @param {Object} profileData - The analyzed brand voice profile
 * @param {string} platform - Target platform
 */
export function getBrandVoiceGenerationSystemPrompt(profileData, platform) {
  const constraints = PLATFORM_CONSTRAINTS[platform] || { name: platform, charLimit: 2000, notes: '' };

  return `You are a social media content creator who has deeply internalized a specific brand's voice. You write original posts that are indistinguishable from the brand's own content.

BRAND VOICE PROFILE:
${JSON.stringify(profileData, null, 2)}

TARGET PLATFORM: ${constraints.name}
CHARACTER LIMIT: ${constraints.charLimit} characters
PLATFORM NOTES: ${constraints.notes}

CRITICAL RULES:
1. Write in the EXACT tone, style, and vocabulary described in the brand voice profile
2. Use the same formatting patterns (emoji style, hashtag patterns, paragraph structure)
3. Stay within the character limit for the target platform
4. The content must be ORIGINAL — do not copy or closely paraphrase any of the sample posts
5. Maintain the brand's emotional register and unique characteristics
6. If the brand voice profile shows platform-specific variations for ${platform}, apply those adaptations
7. The post must feel natural and authentic — as if the brand's actual team wrote it
8. Do NOT include any meta-commentary about the brand voice or the generation process`;
}

/**
 * User prompt for generating an original post.
 * @param {Object} options - Generation options
 * @param {string} options.topic - Optional topic/direction
 * @param {Array} options.samplePosts - 3-5 representative sample posts for few-shot context
 * @param {Object} options.profileData - Brand voice profile for theme reference
 */
export function getBrandVoiceGenerationUserPrompt({ topic, samplePosts = [], profileData }) {
  const samplesText = samplePosts.length > 0
    ? `\nHere are example posts from this brand for reference (DO NOT copy these — use them only to match the style):\n${samplePosts.map((p, i) => `[Example ${i + 1} — ${p.platform}]:\n${p.content}`).join('\n\n')}\n`
    : '';

  const topicInstruction = topic
    ? `Write an original post about the following topic: "${topic}"`
    : `Write an original post about one of the brand's recurring themes: ${(profileData?.content_themes || []).join(', ')}. Choose the most natural and timely theme.`;

  return `${topicInstruction}
${samplesText}
Write exactly ONE post. Output ONLY the post text — no explanations, labels, or meta-commentary.`;
}

/**
 * System prompt for validating a generated test post against original brand posts.
 * The LLM acts as a brand consistency auditor.
 */
export function getBrandVoiceValidationSystemPrompt() {
  return `You are a brand consistency auditor. You will receive:
1. A brand voice profile (the analysis of a brand's social media posts)
2. Several original posts from the brand
3. A newly generated test post that is supposed to match the brand's voice

Your job is to rigorously evaluate how well the test post matches the brand's actual voice. Score it on multiple dimensions and provide an overall score.

Be STRICT — a score of 70+ means the post could reasonably be mistaken for one written by the brand's actual team. A score below 70 means there are noticeable inconsistencies.

Respond with ONLY valid JSON (no markdown code fences, no extra text).`;
}

/**
 * User prompt for validation scoring.
 * @param {Object} profileData - The brand voice profile
 * @param {Array} originalPosts - Sample original posts for comparison
 * @param {string} testPost - The generated test post to validate
 */
export function getBrandVoiceValidationUserPrompt(profileData, originalPosts, testPost) {
  const originals = originalPosts
    .map((p, i) => `[Original ${i + 1}]: ${p.content}`)
    .join('\n\n');

  return `BRAND VOICE PROFILE:
${JSON.stringify(profileData, null, 2)}

ORIGINAL POSTS FROM THE BRAND:
${originals}

TEST POST TO EVALUATE:
${testPost}

Score the test post on each dimension (0-100) and provide an overall weighted score. Respond with this JSON structure:

{
  "scores": {
    "tone_match": <0-100>,
    "vocabulary_match": <0-100>,
    "formatting_match": <0-100>,
    "theme_relevance": <0-100>,
    "authenticity": <0-100>
  },
  "overall_score": <0-100>,
  "strengths": ["What the test post got right"],
  "weaknesses": ["What doesn't match the brand voice"],
  "verdict": "pass" or "fail"
}

Set "verdict" to "pass" if overall_score >= 70, "fail" otherwise.
Respond with ONLY the JSON object.`;
}

export default {
  getBrandVoiceAnalysisSystemPrompt,
  getBrandVoiceAnalysisUserPrompt,
  getBrandVoiceMergeSystemPrompt,
  getBrandVoiceMergeUserPrompt,
  getBrandVoiceGenerationSystemPrompt,
  getBrandVoiceGenerationUserPrompt,
  getBrandVoiceValidationSystemPrompt,
  getBrandVoiceValidationUserPrompt,
  PLATFORM_CONSTRAINTS
};
