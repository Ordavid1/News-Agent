-- ============================================
-- SUPPORT CONVERSATIONS & MESSAGES TABLES
-- Two-way chat system: user sends messages via chat widget,
-- admin replies via email, Resend inbound webhook captures replies
-- Run this in Supabase SQL Editor
-- ============================================

-- Conversations table
CREATE TABLE IF NOT EXISTS public.support_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Sender info
  user_name TEXT NOT NULL,
  user_email TEXT NOT NULL,

  -- Conversation metadata
  category TEXT NOT NULL CHECK (category IN ('Bug Report', 'Feature Request', 'General', 'Account Issue')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages table
CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,

  -- Message content
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'support')),
  message TEXT NOT NULL,

  -- Read tracking (for unread indicators)
  is_read BOOLEAN DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_support_convos_user ON support_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_support_convos_status ON support_conversations(status);
CREATE INDEX IF NOT EXISTS idx_support_convos_updated ON support_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_msgs_convo ON support_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_support_msgs_created ON support_messages(created_at);

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================
ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- Conversations: users can view/insert their own
CREATE POLICY "Users can view own conversations"
  ON support_conversations FOR SELECT
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own conversations"
  ON support_conversations FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own conversations"
  ON support_conversations FOR UPDATE
  USING ((select auth.uid()) = user_id);

-- Messages: users can view messages in their conversations
CREATE POLICY "Users can view messages in own conversations"
  ON support_messages FOR SELECT
  USING (
    conversation_id IN (
      SELECT id FROM support_conversations WHERE user_id = (select auth.uid())
    )
  );

CREATE POLICY "Users can insert messages in own conversations"
  ON support_messages FOR INSERT
  WITH CHECK (
    conversation_id IN (
      SELECT id FROM support_conversations WHERE user_id = (select auth.uid())
    )
  );

-- ============================================
-- GRANTS
-- ============================================
GRANT SELECT, INSERT, UPDATE ON support_conversations TO authenticated;
GRANT ALL ON support_conversations TO service_role;
GRANT SELECT, INSERT, UPDATE ON support_messages TO authenticated;
GRANT ALL ON support_messages TO service_role;
