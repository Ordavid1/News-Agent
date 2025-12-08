-- Add missing columns to profiles table
-- Run this in Supabase SQL Editor

-- API Key for legacy compatibility
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS api_key TEXT;

-- Auto schedule setting
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS auto_schedule BOOLEAN DEFAULT FALSE;

-- Create index on api_key for lookups
CREATE INDEX IF NOT EXISTS idx_profiles_api_key ON profiles(api_key);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
