-- ============================================
-- WHATSAPP PENDING CONNECTIONS TABLE
-- Stores verification codes and pending group connections
-- Run this in Supabase SQL Editor
-- ============================================

-- Create table for pending WhatsApp connections
CREATE TABLE IF NOT EXISTS public.whatsapp_pending_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  -- Verification code (format: NA-XXXXXXXX)
  verification_code TEXT UNIQUE NOT NULL,

  -- Group info (populated when webhook detects the code)
  group_id TEXT,                      -- WhatsApp group JID (e.g., 120363xxx@g.us)
  group_name TEXT,
  group_participant_count INTEGER,

  -- Status tracking
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired')),

  -- Timestamps
  code_generated_at TIMESTAMPTZ DEFAULT NOW(),
  group_detected_at TIMESTAMPTZ,      -- When webhook detected the code in a group
  claimed_at TIMESTAMPTZ,             -- When user claimed the connection
  expires_at TIMESTAMPTZ NOT NULL,    -- Code expiration (30 minutes from generation)

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_user ON whatsapp_pending_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_code ON whatsapp_pending_connections(verification_code);
CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_status ON whatsapp_pending_connections(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_expires ON whatsapp_pending_connections(expires_at);

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================
ALTER TABLE whatsapp_pending_connections ENABLE ROW LEVEL SECURITY;

-- Users can view their own pending connections
CREATE POLICY "Users can view own pending connections"
  ON whatsapp_pending_connections
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own pending connections
CREATE POLICY "Users can insert own pending connections"
  ON whatsapp_pending_connections
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own pending connections
CREATE POLICY "Users can update own pending connections"
  ON whatsapp_pending_connections
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own pending connections
CREATE POLICY "Users can delete own pending connections"
  ON whatsapp_pending_connections
  FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- GRANTS
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_pending_connections TO authenticated;
GRANT ALL ON whatsapp_pending_connections TO service_role;

-- ============================================
-- CLEANUP FUNCTION (optional - for expired codes)
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_expired_whatsapp_codes()
RETURNS void AS $$
BEGIN
  UPDATE whatsapp_pending_connections
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
