import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';

const router = express.Router();

// ============================================================================
// POST /api/blocks - Block a user
// ============================================================================

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { user_id_to_block } = req.body;

    if (!user_id_to_block) {
      return res.status(400).json({ error: 'user_id_to_block is required' });
    }

    if (userId === user_id_to_block) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    // Check if user to block exists
    const userCheck = await query(
      `SELECT id FROM users WHERE id = $1`,
      [user_id_to_block]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if already blocked
    const blockCheck = await query(
      `SELECT id FROM user_blocks WHERE user_id = $1 AND blocked_user_id = $2`,
      [userId, user_id_to_block]
    );

    if (blockCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User already blocked' });
    }

    // Create block
    const blockId = uuidv4();
    const result = await query(
      `INSERT INTO user_blocks (id, user_id, blocked_user_id, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, blocked_user_id, created_at`,
      [blockId, userId, user_id_to_block, new Date()]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// ============================================================================
// GET /api/blocks - Get blocked users
// ============================================================================

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      `SELECT u.id, u.email, u.name, u.age, u.gender, u.avatar_url, u.is_verified, u.is_active, u.created_at
       FROM user_blocks ub
       JOIN users u ON ub.blocked_user_id = u.id
       WHERE ub.user_id = $1
       ORDER BY ub.created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

// ============================================================================
// DELETE /api/blocks/:userId - Unblock a user
// ============================================================================

router.delete('/:userId', async (req: Request, res: Response) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    if (!currentUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Delete the block
    const result = await query(
      `DELETE FROM user_blocks 
       WHERE user_id = $1 AND blocked_user_id = $2
       RETURNING id`,
      [currentUserId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }

    res.json({
      success: true,
      message: 'User unblocked successfully',
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

export default router;