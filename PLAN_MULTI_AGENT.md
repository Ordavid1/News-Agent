# Multi-Agent Architecture Implementation Plan

## Overview

Transform the current single-settings model into a multi-agent architecture where:
- Each user can create multiple "News Agents"
- Each agent is tied to a specific platform connection
- Each agent has its own configuration (topics, keywords, geo, tone, schedule)
- Number of agents is limited by subscription tier

## Current State Analysis

### Existing Architecture
1. **Single settings model**: User settings stored in `profiles` table columns
2. **Platform connections**: Stored in `social_connections` table (independent from settings)
3. **Test post flow**: Uses single user settings to post to ALL connected platforms

### Key Files
- `routes/users.js`: Settings API at GET/PUT `/api/users/settings`
- `routes/posts.js`: Test post uses `user.settings` and `user.automation`
- `public/settings.html`: Single configuration form
- `public/profile.html`: Dashboard with connections tab
- `supabase/schema.sql`: Database schema

---

## Implementation Plan

### Phase 1: Database Schema

Create new `agents` table in Supabase:

```sql
-- agents table - one agent per platform connection
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  connection_id UUID REFERENCES social_connections(id) ON DELETE CASCADE NOT NULL,

  -- Basic info
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),

  -- Agent-specific configuration (JSONB for flexibility)
  settings JSONB DEFAULT '{
    "topics": [],
    "keywords": [],
    "geoFilter": { "region": "", "includeGlobal": true },
    "schedule": { "postsPerDay": 3, "startTime": "09:00", "endTime": "21:00" },
    "contentStyle": { "tone": "professional", "includeHashtags": true }
  }',

  -- Tracking
  last_posted_at TIMESTAMPTZ,
  posts_today INTEGER DEFAULT 0,
  total_posts INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One agent per connection (prevents duplicate agents for same platform)
  UNIQUE(connection_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_platform ON agents(platform);

-- RLS Policies
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own agents"
  ON agents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own agents"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own agents"
  ON agents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own agents"
  ON agents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO authenticated;
GRANT ALL ON public.agents TO service_role;
```

---

### Phase 2: Backend API

#### New file: `routes/agents.js`

```javascript
// routes/agents.js - Agent CRUD operations

// GET /api/agents - List user's agents
// POST /api/agents - Create new agent (requires connection_id)
// GET /api/agents/:id - Get agent details
// PUT /api/agents/:id - Update agent settings
// PUT /api/agents/:id/status - Toggle agent status (active/paused)
// DELETE /api/agents/:id - Delete agent
```

#### Agent Limits by Tier

```javascript
const agentLimits = {
  free: 1,
  starter: 2,
  growth: 5,
  professional: 10,
  business: -1  // unlimited
};
```

#### Modify `routes/posts.js`

Update test post endpoint to:
1. Accept optional `agent_id` parameter
2. If provided, use that agent's settings
3. If not provided, use first active agent or fallback to legacy settings

---

### Phase 3: Frontend - profile.html (Agents Tab)

Add new "Agents" tab between Dashboard and Connections:

```html
<button onclick="showTab('agents')" id="tab-agents" class="tab-btn ...">
  <span class="flex items-center gap-2">
    <svg><!-- robot icon --></svg>
    Agents
    <span id="agentCount" class="text-xs bg-gray-700 px-2 py-0.5 rounded-full">0/1</span>
  </span>
</button>
```

#### Agents Tab Content:

1. **Header Section**
   - Title: "Your News Agents"
   - Subtitle: "Each agent posts to a specific platform with its own settings"
   - "Create Agent" button (opens modal)

2. **Agent Cards Grid**
   - Platform icon and name
   - Agent name (editable)
   - Status badge (Active/Paused)
   - Last posted time
   - Posts today counter
   - Quick actions: Configure, Toggle, Delete

3. **Create Agent Modal**
   - Select from connected platforms that don't have agents
   - Enter agent name
   - Creates agent with default settings
   - Redirects to settings page

4. **Empty State**
   - If no connections: "Connect a platform first"
   - If connections but no agents: "Create your first agent"

---

### Phase 4: Frontend - settings.html Modifications

#### URL Parameter Support

Accept `?agent=<agent_id>` parameter to load/save agent-specific settings.

#### Header Changes

When editing an agent:
- Show agent name and platform badge
- Back button goes to profile.html?tab=agents

#### Form Changes

- Remove "Platform Settings" section (agent is already tied to one platform)
- All other fields remain the same but load/save from agent record

#### API Changes

When agent parameter present:
- GET `/api/agents/:id` instead of `/api/users/settings`
- PUT `/api/agents/:id` instead of `/api/users/settings`

---

### Phase 5: Flow Changes

#### New User Flow:
1. User signs up (free tier - 1 agent)
2. User connects Twitter
3. User goes to Agents tab
4. Clicks "Create Agent", selects Twitter, names it "My Twitter Bot"
5. Agent created with default settings
6. User clicks "Configure" -> goes to settings.html?agent=<id>
7. User configures topics, keywords, tone, etc.
8. User saves -> redirected to Agents tab
9. User clicks "Try One Post" on agent card -> uses that agent's settings

#### Test Post Flow:
1. If from agent card: POST /api/posts/test?agent=<id>
2. Backend loads agent settings
3. Uses agent's connection for publishing
4. Records post against agent (last_posted_at, posts_today)

---

### Phase 6: Migration Strategy

#### Backwards Compatibility

1. Keep existing `/api/users/settings` endpoint working
2. When user first visits Agents tab:
   - Check if they have connections but no agents
   - Auto-create agents from existing connections with current settings
3. Legacy settings remain as fallback

#### Migration Script

```javascript
// Auto-create agents from existing connections
async function migrateUserToAgents(userId) {
  const connections = await getUserConnections(userId);
  const existingAgents = await getUserAgents(userId);
  const userSettings = await getUserSettings(userId);

  for (const conn of connections) {
    if (!existingAgents.find(a => a.connection_id === conn.id)) {
      await createAgent({
        userId,
        connectionId: conn.id,
        name: `${conn.platform} Agent`,
        platform: conn.platform,
        settings: userSettings // Copy current settings
      });
    }
  }
}
```

---

## File Changes Summary

### New Files
1. `routes/agents.js` - Agent CRUD routes
2. `services/AgentService.js` - Agent business logic
3. `public/js/agents.js` - Frontend agent management
4. `supabase/agents_table.sql` - Database migration

### Modified Files
1. `server.js` - Register agents routes
2. `routes/posts.js` - Support agent_id in test post
3. `public/profile.html` - Add Agents tab
4. `public/js/profile.js` - Agent tab handlers
5. `public/settings.html` - Support agent parameter
6. `public/js/settings.js` - Load/save agent settings
7. `middleware/subscription.js` - Add agent limit enforcement
8. `services/database.js` - Add agent CRUD functions

---

## Pricing Tier Display (profile.html subscription tab)

Update plan cards to show agent limits:

| Tier | Posts | Agents | Platforms |
|------|-------|--------|-----------|
| Free | 1/week | 1 | Twitter only |
| Starter | 10 | 2 | Twitter, LinkedIn |
| Growth | 30 | 5 | All platforms |
| Professional | Unlimited | 10 | All platforms |
| Business | Unlimited | Unlimited | All + API access |

---

## Questions to Clarify

1. **Agent per platform limit**: Should users be able to create multiple agents for the same platform (e.g., 2 Twitter agents with different topics)?
   - Current plan: One agent per connection (connection is unique per platform)
   - Alternative: Allow multiple agents per platform (requires removing UNIQUE constraint)

2. **Default behavior**: When "Try One Post" is clicked from Dashboard (not agent card), should it:
   - Post to ALL active agents?
   - Post to first/primary agent only?
   - Show a selection modal?

3. **Auto-creation**: Should agents be auto-created when a user connects a new platform?
   - Pro: Simpler UX
   - Con: User might not want to use all connected platforms for automation

4. **Posting quota**: Should post limits be:
   - Per user total (current behavior)?
   - Per agent?
   - Combination (user daily limit, agent has own schedule)?

---

## Implementation Order

1. Database migration (agents table)
2. Backend routes and services
3. Profile.html agents tab UI
4. Settings.html agent support
5. Test post agent support
6. Pricing tier enforcement
7. Migration script for existing users
8. Testing and refinement
