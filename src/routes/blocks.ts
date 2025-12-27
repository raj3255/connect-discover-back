import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { setRedis, deleteRedis, addToSet, removeFromSet } from '../config/redis.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// GET BLOCKED USERS - Get list of users blocked by current user
// ============================================================================
// QUERY: Get all blocked users with details
// Shows who you've blocked

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const result = await query(
      `SELECT b.id, b.blocked_id, b.reason, b.created_at, u.name, u.avatar_url
       FROM blocked_users b
       JOIN users u ON b.blocked_id = u.id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [userId]
    );

    res.json({ blockedUsers: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({ error: 'Failed to get blocked users' });
  }
});

// ============================================================================
// BLOCK USER - Block a user
// ============================================================================
// QUERY: Insert into blocked_users table
// Also cache in Redis for fast lookups during messaging

router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { blockedUserId, reason } = req.body;

    if (!blockedUserId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    const blockUserIdStr = String(blockedUserId);

    if (userId === blockedUserId) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    // Check if already blocked
    const existingResult = await query(
      `SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
      [userId, blockedUserId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'User already blocked' });
    }

    // Insert block
    const blockId = uuidv4();
    const result = await query(
      `INSERT INTO blocked_users (id, blocker_id, blocked_id, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [blockId, userId, blockUserIdStr, reason || null]
    );

    // Cache in Redis for fast lookups
    await addToSet(`blocked:${userId}`, blockUserIdStr);
    await addToSet(`blocked_by:${blockUserIdStr}`, userId);

    res.status(201).json({ message: 'User blocked', block: result.rows[0] });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// ============================================================================
// UNBLOCK USER - Unblock a user
// ============================================================================
// QUERY: Delete from blocked_users table
// Also remove from Redis cache

router.delete('/:blockedUserId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { blockedUserId } = req.params;

    const blockUserIdStr = String(blockedUserId);

    // Delete block
    const result = await query(
      `DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2 RETURNING *`,
      [userId, blockUserIdStr]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }

    // Remove from Redis
    await removeFromSet(`blocked:${userId}`, blockUserIdStr);
    await removeFromSet(`blocked_by:${blockUserIdStr}`, userId);

    res.json({ message: 'User unblocked' });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// ============================================================================
// CHECK BLOCK STATUS - Check if users are blocked
// ============================================================================
// QUERY: Check Redis first, then database
// Returns if current user blocked someone or is blocked

router.get('/check/:otherUserId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { otherUserId } = req.params;

    // Check if current user blocked other user
    const blockedResult = await query(
      `SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
      [userId, otherUserId]
    );

    // Check if current user is blocked by other user
    const blockedByResult = await query(
      `SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
      [otherUserId, userId]
    );

    res.json({
      isBlocked: blockedResult.rows.length > 0,
      isBlockedBy: blockedByResult.rows.length > 0,
    });
  } catch (error) {
    console.error('Check block status error:', error);
    res.status(500).json({ error: 'Failed to check block status' });
  }
});

export default router;