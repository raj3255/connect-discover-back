import express from 'express';
import type { Request, Response } from 'express';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, schemas } from '../utils/validators.js';

const router = express.Router();

// ============================================================================
// GET PROFILE - Get current user's full profile
// ============================================================================

router.get('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get user details
    const result = await query(
      `SELECT id, email, name, age, bio, gender, interests, avatar_url, is_verified, created_at, updated_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get user's albums count
    const albumsResult = await query(
      `SELECT COUNT(*) as count FROM albums WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    // Get user's location
    const locationResult = await query(
      `SELECT latitude, longitude, updated_at FROM locations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );

    res.json({
      user: {
        ...user,
        albumsCount: parseInt(albumsResult.rows[0].count),
        location: locationResult.rows.length > 0 ? locationResult.rows[0] : null,
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// ============================================================================
// GET USER BY ID - Get another user's public profile
// ============================================================================

router.get('/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.userId;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Check if current user has blocked this user or vice versa
    const blockedResult = await query(
      `SELECT id FROM blocked_users 
       WHERE (blocker_id = $1 AND blocked_id = $2) 
       OR (blocker_id = $2 AND blocked_id = $1)`,
      [currentUserId, userId]
    );

    if (blockedResult.rows.length > 0) {
      return res.status(403).json({ error: 'User not available' });
    }

    // Get user details (public info only)
    const result = await query(
      `SELECT id, name, age, bio, gender, interests, avatar_url, is_verified, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get user's location (if they're nearby)
    const locationResult = await query(
      `SELECT latitude, longitude FROM locations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );

    res.json({
      user: {
        ...user,
        location: locationResult.rows.length > 0 ? locationResult.rows[0] : null,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ============================================================================
// UPDATE PROFILE - Update user information
// ============================================================================

router.put('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { error, value } = validate(schemas.updateProfile, req.body);

    if (error) {
      const messages = error.details.map((d) => d.message);
      return res.status(400).json({ error: 'Validation failed', details: messages });
    }

    const { name, bio, interests, age, gender } = value;

    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramCount++}`);
      values.push(bio);
    }
    if (interests !== undefined) {
      updates.push(`interests = $${paramCount++}`);
      values.push(interests);
    }
    if (age !== undefined) {
      updates.push(`age = $${paramCount++}`);
      values.push(age);
    }
    if (gender !== undefined) {
      updates.push(`gender = $${paramCount++}`);
      values.push(gender);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    const result = await query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Profile updated successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================================================
// UPLOAD AVATAR - Update user avatar
// ============================================================================

router.post('/avatar', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { avatarUrl } = req.body;

    if (!avatarUrl) {
      return res.status(400).json({ error: 'Avatar URL required' });
    }

    // Update avatar
    const result = await query(
      `UPDATE users SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING avatar_url`,
      [avatarUrl, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Avatar updated successfully',
      avatarUrl: result.rows[0].avatar_url,
    });
  } catch (error) {
    console.error('Upload avatar error:', error);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

// ============================================================================
// SEARCH USERS - Search users by name or interests
// ============================================================================

// In src/routes/users.ts, replace the SEARCH USERS section with:

router.get('/search/:query', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { query: searchQuery } = req.params;
    const currentUserId = req.userId;

    if (!searchQuery || searchQuery.length < 1) {
      return res.status(400).json({ error: 'Search query required' });
    }

    console.log(`Searching for: "${searchQuery}" by user: ${currentUserId}`);

    // Search users by name or interests (case-insensitive)
    const result = await query(
      `SELECT id, name, age, bio, gender, interests, avatar_url, is_verified
       FROM users 
       WHERE (LOWER(name) LIKE LOWER($1) OR LOWER(interests) LIKE LOWER($1))
       AND id != $2
       AND deleted_at IS NULL
       LIMIT 20`,
      [`%${searchQuery}%`, currentUserId]
    );

    console.log(`Found ${result.rows.length} users`);

    res.json({ users: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================================================
// GET ONLINE USERS - Get list of online users (for global mode)
// ============================================================================

router.get('/online/list', authMiddleware, async (req: Request, res: Response) => {
  try {
    // This would typically get from Redis in production
    // For now, return recent active users
    const result = await query(
      `SELECT id, name, age, avatar_url, is_verified
       FROM users 
       WHERE is_active = true AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 50`
    );

    res.json({ onlineUsers: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Get online users error:', error);
    res.status(500).json({ error: 'Failed to get online users' });
  }
});

// ============================================================================
// DELETE ACCOUNT - Soft delete user account
// ============================================================================

router.delete('/account', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password required for account deletion' });
    }

    // Get user and verify password
    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const bcryptjs = await import('bcryptjs');
    const passwordMatch = await bcryptjs.default.compare(password, userResult.rows[0].password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Soft delete user
    await query('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);

    // Invalidate all sessions
    await query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;