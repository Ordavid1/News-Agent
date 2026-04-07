-- Add cinematic v2 pipeline statuses to brand_story_episodes.
-- New statuses: writing_script, generating_narration, post_production

ALTER TABLE brand_story_episodes DROP CONSTRAINT IF EXISTS brand_story_episodes_status_check;

ALTER TABLE brand_story_episodes ADD CONSTRAINT brand_story_episodes_status_check
  CHECK (status IN (
    'pending',
    'writing_script',
    'generating_scene',
    'generating_narration',
    'generating_storyboard',
    'generating_avatar',
    'generating_video',
    'post_production',
    'compositing',
    'ready',
    'publishing',
    'published',
    'failed'
  ));
