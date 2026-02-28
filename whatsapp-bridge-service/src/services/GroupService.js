import logger from '../utils/logger.js';

/**
 * Handles WhatsApp group operations — listing groups and retrieving metadata.
 * Uses the SessionManager's group cache to reduce API calls.
 */
class GroupService {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * List all groups the account participates in
   * @returns {{ groups: Array<{ id, name, subject, participants }> }}
   */
  async listGroups() {
    const sock = this.sessionManager.getSocket();
    const groupsMap = await sock.groupFetchAllParticipating();

    const groups = Object.values(groupsMap).map(group => ({
      id: group.id,
      name: group.subject || 'Unknown Group',
      subject: group.subject || '',
      participants: (group.participants || []).map(p => ({
        id: p.id,
        admin: p.admin || null
      }))
    }));

    logger.debug(`Listed ${groups.length} groups`);

    // Update cache
    for (const group of groups) {
      this.sessionManager.groupCache.set(group.id, group);
    }

    return { groups };
  }

  /**
   * Get metadata for a specific group
   * @param {string} groupId - Group JID (e.g., 120363xxxxx@g.us)
   * @returns {Object} Group metadata
   */
  async getGroupMetadata(groupId) {
    if (!groupId) throw new Error('Group ID is required');

    // Check cache first
    const cached = this.sessionManager.groupCache.get(groupId);
    if (cached) {
      logger.debug(`Group metadata cache hit: ${groupId}`);
      return cached;
    }

    const sock = this.sessionManager.getSocket();
    const meta = await sock.groupMetadata(groupId);

    const group = {
      id: meta.id,
      name: meta.subject || 'Unknown Group',
      subject: meta.subject || '',
      participants: (meta.participants || []).map(p => ({
        id: p.id,
        admin: p.admin || null
      })),
      owner: meta.owner || null,
      creation: meta.creation || null,
      desc: meta.desc || null
    };

    // Cache the result
    this.sessionManager.groupCache.set(groupId, group);

    logger.debug(`Group metadata fetched: ${group.name} (${group.participants.length} members)`);
    return group;
  }
}

export default GroupService;
