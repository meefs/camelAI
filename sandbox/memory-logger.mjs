/**
 * User Profile - Utility Functions
 *
 * Profile: Persistent user profile - preferences, quirks, inside jokes
 *
 * Storage:
 * - Profile: ~/.chiridion/profile.md
 */

import { readFile } from 'fs/promises';

const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
export const PROFILE_PATH = `${SYNC_DIR}/.chiridion/profile.md`;

/**
 * Load user profile
 *
 * Returns the full profile content or null if no profile exists.
 * The profile is always included in the system prompt.
 *
 * @returns {Promise<string|null>} Profile content or null
 */
export async function loadUserProfile() {
  try {
    const content = await readFile(PROFILE_PATH, 'utf-8');
    if (content.trim()) {
      console.log('[profile] Loaded user profile', { length: content.length });
      return content;
    }
    return null;
  } catch (error) {
    // File doesn't exist yet - that's fine
    if (error.code !== 'ENOENT') {
      console.error('[profile] Failed to load profile:', error?.message || String(error));
    }
    return null;
  }
}
