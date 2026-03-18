-- Add topic_context column to agent_article_usage for semantic dedup
-- Stores a ~100 char LLM-generated summary of the article's core topic and context
-- Used to prevent the same topic from being selected repeatedly

ALTER TABLE agent_article_usage
ADD COLUMN IF NOT EXISTS topic_context TEXT;

-- Index for efficient similarity lookups within time window
CREATE INDEX IF NOT EXISTS idx_agent_article_topic_context
ON agent_article_usage (agent_id, used_at DESC)
WHERE topic_context IS NOT NULL;
