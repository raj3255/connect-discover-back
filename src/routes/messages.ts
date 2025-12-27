import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// GET MESSAGES - Get messages in conversation (paginated)
// ============================================================================
// QUERY: Get messages ordered by date, paginated
// Load 50 messages per page, older messages on scroll up

router.get('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;
    const { page = 1, limit = 50 } = req.query;

    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 50;
    const offset = (pageNum - 1) * limitNum;

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

    // Get messages
    const result = await query(
      `SELECT id, sender_id, text, media_urls, message_type, is_read, read_at, created_at
       FROM messages 
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [conversationId, limitNum, offset]
    );

    // Reverse to get chronological order
    const messages = result.rows.reverse();

    res.json({ messages, count: messages.length, page: pageNum });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ============================================================================
// SEND MESSAGE - Insert new message
// ============================================================================
// QUERY: Insert message and update conversation last_message_at
// Also check if users are blocked

router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { conversationId, text, mediaUrls, messageType = 'text' } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID required' });
    }

    if (!text && (!mediaUrls || mediaUrls.length === 0)) {
      return res.status(400).json({ error: 'Message text or media required' });
    }

    // Verify user is participant and get other user
    const conversationResult = await query(
      `SELECT user_1_id, user_2_id FROM conversations WHERE id = $1`,
      [conversationId]
    );

    if (conversationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { user_1_id, user_2_id } = conversationResult.rows[0];
    const otherUserId = userId === user_1_id ? user_2_id : user_1_id;

    if (userId !== user_1_id && userId !== user_2_id) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // Check if blocked
    const blockedResult = await query(
      `SELECT id FROM blocked_users 
       WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [userId, otherUserId]
    );

    if (blockedResult.rows.length > 0) {
      return res.status(403).json({ error: 'Cannot send message to blocked user' });
    }

    // Insert message
    const messageId = uuidv4();
    const insertResult = await query(
      `INSERT INTO messages (id, conversation_id, sender_id, text, media_urls, message_type, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, CURRENT_TIMESTAMP)
       RETURNING *`,
      [messageId, conversationId, userId, text || null, mediaUrls || [], messageType]
    );

    // Update conversation last_message_at
    await query(
      `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversationId]
    );

    const message = insertResult.rows[0];

    res.status(201).json({
      id: message.id,
      conversationId: message.conversation_id,
      senderId: message.sender_id,
      text: message.text,
      mediaUrls: message.media_urls,
      messageType: message.message_type,
      isRead: message.is_read,
      createdAt: message.created_at,
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================================
// MARK MESSAGE AS READ - Update read status
// ============================================================================
// QUERY: Mark specific message as read
// Called when user sees message on screen

router.put('/:messageId/read', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.userId;

    // Get message and verify user is recipient
    const messageResult = await query(
      `SELECT m.*, c.user_1_id, c.user_2_id 
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE m.id = $1`,
      [messageId]
    );

    if (messageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const message = messageResult.rows[0];

    // Only recipient can mark as read
    if (userId !== message.user_1_id && userId !== message.user_2_id) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    if (userId === message.sender_id) {
      return res.status(400).json({ error: 'Cannot mark own message as read' });
    }

    // Mark as read
    await query(
      `UPDATE messages SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [messageId]
    );

    res.json({ message: 'Message marked as read' });
  } catch (error) {
    console.error('Mark message as read error:', error);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// ============================================================================
// DELETE MESSAGE - Soft delete message
// ============================================================================
// QUERY: Only sender can delete their own message
// Mark as deleted but keep for history

router.delete('/:messageId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.userId;

    // Verify sender
    const messageResult = await query(
      `SELECT sender_id FROM messages WHERE id = $1`,
      [messageId]
    );

    if (messageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (messageResult.rows[0].sender_id !== userId) {
      return res.status(403).json({ error: 'Can only delete own messages' });
    }

    // Soft delete - set text to [deleted]
    await query(
      `UPDATE messages SET text = '[deleted]', media_urls = '[]' WHERE id = $1`,
      [messageId]
    );

    res.json({ message: 'Message deleted' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ============================================================================
// SEARCH MESSAGES - Search in conversation
// ============================================================================
// QUERY: Search messages by text content
// Full-text search in conversation

router.get('/:conversationId/search', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const { q } = req.query;
    const userId = req.userId;

    if (!q || (q as string).length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

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

    // Search messages
    const result = await query(
      `SELECT id, sender_id, text, message_type, created_at
       FROM messages 
       WHERE conversation_id = $1 AND text ILIKE $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [conversationId, `%${q}%`]
    );

    res.json({ messages: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

export default router;