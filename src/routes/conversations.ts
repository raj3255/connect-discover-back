import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// GET CONVERSATIONS - Get all conversations for current user
// ============================================================================
// QUERY: Get conversations with last message and unread count
// Shows all active conversations with most recent one first

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Get conversations for user
    const result = await query(
      `SELECT 
        c.id,
        c.user_1_id,
        c.user_2_id,
        c.chat_mode,
        c.started_at,
        c.last_message_at,
        c.is_active,
        m.text as last_message_text,
        m.created_at as last_message_time,
        m.sender_id as last_message_sender,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != $1 AND is_read = false) as unread_count,
        CASE 
          WHEN c.user_1_id = $1 THEN c.user_2_id 
          ELSE c.user_1_id 
        END as other_user_id
       FROM conversations c
       LEFT JOIN messages m ON m.id = (
         SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE (c.user_1_id = $1 OR c.user_2_id = $1) AND c.is_active = true
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [userId, limitNum, offset]
    );

    // Get other user details for each conversation
    const conversations = await Promise.all(
      result.rows.map(async (conv) => {
        const otherUserResult = await query(
          `SELECT id, name, avatar_url, is_verified FROM users WHERE id = $1`,
          [conv.other_user_id]
        );

        return {
          id: conv.id,
          otherUser: otherUserResult.rows[0],
          chatMode: conv.chat_mode,
          lastMessage: conv.last_message_text ? {
            text: conv.last_message_text,
            senderId: conv.last_message_sender,
            timestamp: conv.last_message_time
          } : null,
          unreadCount: parseInt(conv.unread_count),
          startedAt: conv.started_at,
          isActive: conv.is_active,
        };
      })
    );

    res.json({ conversations, count: conversations.length, page: pageNum });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// ============================================================================
// GET CONVERSATION - Get single conversation details
// ============================================================================
// QUERY: Get conversation with both users' details
// Verifies user is participant before returning

router.get('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    // Verify user is participant
    const participantResult = await query(
      `SELECT user_1_id, user_2_id FROM conversations WHERE id = $1`,
      [conversationId]
    );

    if (participantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { user_1_id, user_2_id } = participantResult.rows[0];

    if (userId !== user_1_id && userId !== user_2_id) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    // Get conversation details
    const result = await query(
      `SELECT * FROM conversations WHERE id = $1`,
      [conversationId]
    );

    const conversation = result.rows[0];

    // Get both users' details
    const otherUserId = userId === user_1_id ? user_2_id : user_1_id;
    const otherUserResult = await query(
      `SELECT id, name, avatar_url, is_verified FROM users WHERE id = $1`,
      [otherUserId]
    );

    res.json({
      conversation: {
        ...conversation,
        otherUser: otherUserResult.rows[0],
      },
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// ============================================================================
// CREATE CONVERSATION - Create or get existing 1-to-1 conversation
// ============================================================================
// QUERY: Check if conversation exists, if not create it
// Returns conversation ID to use for messaging

router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { otherUserId, chatMode = 'local' } = req.body;

    if (!otherUserId) {
      return res.status(400).json({ error: 'Other user ID required' });
    }

    if (userId === otherUserId) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    // Check if blocked
    const blockedResult = await query(
      `SELECT id FROM blocked_users 
       WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [userId, otherUserId]
    );

    if (blockedResult.rows.length > 0) {
      return res.status(403).json({ error: 'Cannot create conversation with this user' });
    }

    // Check if conversation already exists
    const existingResult = await query(
      `SELECT id FROM conversations 
       WHERE (user_1_id = $1 AND user_2_id = $2) OR (user_1_id = $2 AND user_2_id = $1)`,
      [userId, otherUserId]
    );

    if (existingResult.rows.length > 0) {
      // Update to active if it was inactive
      await query(
        `UPDATE conversations SET is_active = true, last_message_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [existingResult.rows[0].id]
      );
      return res.json({ conversationId: existingResult.rows[0].id, isNew: false });
    }

    // Create new conversation
    const conversationId = uuidv4();
    await query(
      `INSERT INTO conversations (id, user_1_id, user_2_id, chat_mode, is_active, last_message_at)
       VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)`,
      [conversationId, userId, otherUserId, chatMode]
    );

    res.status(201).json({ conversationId, isNew: true });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ============================================================================
// DELETE CONVERSATION - Soft delete conversation
// ============================================================================
// QUERY: Mark conversation as inactive
// User can still view history but won't see in active conversations

router.delete('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    // Verify user is participant
    const participantResult = await query(
      `SELECT user_1_id, user_2_id FROM conversations WHERE id = $1`,
      [conversationId]
    );

    if (participantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { user_1_id, user_2_id } = participantResult.rows[0];

    if (userId !== user_1_id && userId !== user_2_id) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // Soft delete
    await query(
      `UPDATE conversations SET is_active = false WHERE id = $1`,
      [conversationId]
    );

    res.json({ message: 'Conversation deleted' });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// ============================================================================
// MARK AS READ - Mark all messages as read in conversation
// ============================================================================
// QUERY: Update all unread messages from other user
// Helps track which conversations you've read

router.put('/:conversationId/mark-read', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    // Verify user is participant
    const participantResult = await query(
      `SELECT user_1_id, user_2_id FROM conversations WHERE id = $1`,
      [conversationId]
    );

    if (participantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { user_1_id, user_2_id } = participantResult.rows[0];

    if (userId !== user_1_id && userId !== user_2_id) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // Mark all messages from other user as read
    await query(
      `UPDATE messages 
       SET is_read = true, read_at = CURRENT_TIMESTAMP 
       WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false`,
      [conversationId, userId]
    );

    res.json({ message: 'Marked as read' });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ============================================================================
// GET UNREAD COUNT - Get total unread message count
// ============================================================================
// QUERY: Count all unread messages across all conversations
// For badge notification

router.get('/unread/count', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT COUNT(*) as unread_count 
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE (c.user_1_id = $1 OR c.user_2_id = $1) AND m.sender_id != $1 AND m.is_read = false`,
      [userId]
    );

    res.json({ unreadCount: parseInt(result.rows[0].unread_count) });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

export default router;