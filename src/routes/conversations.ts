// src/routes/conversations.ts
// UPDATED TO MATCH YOUR DATABASE SCHEMA
import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// GET CONVERSATIONS - List user's conversations
// ============================================================================
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Get conversations with last message and other user info
    const result = await query(
      `SELECT 
        c.id as conversation_id,
        c.chat_mode,
        c.created_at,
        c.last_message_at,
        u.id as other_user_id,
        u.name as other_user_name,
        u.avatar_url as other_user_avatar,
        u.is_verified as other_user_verified,
        (
          SELECT text 
          FROM messages 
          WHERE conversation_id = c.id 
          ORDER BY created_at DESC 
          LIMIT 1
        ) as last_message_text,
        (
          SELECT sender_id 
          FROM messages 
          WHERE conversation_id = c.id 
          ORDER BY created_at DESC 
          LIMIT 1
        ) as last_message_sender_id,
        (
          SELECT created_at 
          FROM messages 
          WHERE conversation_id = c.id 
          ORDER BY created_at DESC 
          LIMIT 1
        ) as last_message_timestamp,
        (
          SELECT COUNT(*) 
          FROM messages 
          WHERE conversation_id = c.id 
          AND sender_id != $1 
          AND is_read = false
        ) as unread_count
       FROM conversations c
       JOIN users u ON (
         CASE 
           WHEN c.user_1_id = $1 THEN c.user_2_id
           ELSE c.user_1_id
         END = u.id
       )
       WHERE (c.user_1_id = $1 OR c.user_2_id = $1)
       AND c.is_active = true
       AND u.deleted_at IS NULL
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [userId, limitNum, offset]
    );

    const conversations = result.rows.map(row => ({
      id: row.conversation_id,
      chatMode: row.chat_mode,
      otherUser: {
        id: row.other_user_id,
        name: row.other_user_name,
        avatar_url: row.other_user_avatar,
        is_verified: row.other_user_verified
      },
      lastMessage: row.last_message_text ? {
        text: row.last_message_text,
        senderId: row.last_message_sender_id,
        timestamp: row.last_message_timestamp
      } : null,
      unreadCount: parseInt(row.unread_count) || 0,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at
    }));

    res.json({
      conversations,
      count: conversations.length,
      page: pageNum
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// ============================================================================
// CREATE CONVERSATION - Start new conversation
// ============================================================================
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { otherUserId, chatMode = 'text' } = req.body;

    if (!otherUserId) {
      return res.status(400).json({ error: 'Other user ID required' });
    }

    if (userId === otherUserId) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    // Check if other user exists
    const userResult = await query(
      `SELECT id, name, avatar_url FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [otherUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if blocked (YOUR schema: user_blocks)
    const blockResult = await query(
      `SELECT id FROM user_blocks 
       WHERE (user_id = $1 AND blocked_user_id = $2)
       OR (user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
      [userId, otherUserId]
    );

    if (blockResult.rows.length > 0) {
      return res.status(403).json({ error: 'Cannot create conversation with blocked user' });
    }

    // Check if conversation already exists
    const existingResult = await query(
      `SELECT id, chat_mode FROM conversations 
       WHERE ((user_1_id = $1 AND user_2_id = $2) 
       OR (user_1_id = $2 AND user_2_id = $1))
       AND is_active = true`,
      [userId, otherUserId]
    );

    if (existingResult.rows.length > 0) {
      return res.json({
        conversation: {
          id: existingResult.rows[0].id,
          chatMode: existingResult.rows[0].chat_mode,
          otherUser: userResult.rows[0],
          message: 'Conversation already exists'
        }
      });
    }

    // Create new conversation
    const conversationId = uuidv4();
    await query(
      `INSERT INTO conversations (id, user_1_id, user_2_id, chat_mode, is_active, created_at, last_message_at)
       VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [conversationId, userId, otherUserId, chatMode]
    );

    res.status(201).json({
      conversation: {
        id: conversationId,
        chatMode,
        otherUser: userResult.rows[0],
        createdAt: new Date()
      }
    });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ============================================================================
// GET CONVERSATION - Get specific conversation
// ============================================================================
router.get('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    // Get conversation with other user info
    const result = await query(
      `SELECT 
        c.id,
        c.user_1_id,
        c.user_2_id,
        c.chat_mode,
        c.created_at,
        u.id as other_user_id,
        u.name as other_user_name,
        u.avatar_url as other_user_avatar,
        u.bio as other_user_bio,
        u.is_verified as other_user_verified
       FROM conversations c
       JOIN users u ON (
         CASE 
           WHEN c.user_1_id = $1 THEN c.user_2_id
           ELSE c.user_1_id
         END = u.id
       )
       WHERE c.id = $2 AND (c.user_1_id = $1 OR c.user_2_id = $1)
       AND u.deleted_at IS NULL`,
      [userId, conversationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conv = result.rows[0];

    res.json({
      conversation: {
        id: conv.id,
        chatMode: conv.chat_mode,
        otherUser: {
          id: conv.other_user_id,
          name: conv.other_user_name,
          avatar_url: conv.other_user_avatar,
          bio: conv.other_user_bio,
          is_verified: conv.other_user_verified
        },
        createdAt: conv.created_at
      }
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// ============================================================================
// GET MESSAGES - Get messages in conversation
// ============================================================================
router.get('/:conversationId/messages', authMiddleware, async (req: Request, res: Response) => {
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
      `SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.text,
        m.media_urls,
        m.message_type,
        m.is_read,
        m.read_at,
        m.created_at,
        u.name as sender_name,
        u.avatar_url as sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [conversationId, limitNum, offset]
    );

    // Reverse to get chronological order
    const messages = result.rows.reverse();

    res.json({
      messages,
      count: messages.length,
      page: pageNum
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ============================================================================
// SEND MESSAGE - Send message in conversation
// ============================================================================
router.post('/:conversationId/messages', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;
    const { text, mediaUrls } = req.body;

    if (!text && (!mediaUrls || mediaUrls.length === 0)) {
      return res.status(400).json({ error: 'Message text or media required' });
    }

    // Verify participant
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

    // Insert message
    const messageId = uuidv4();
    const result = await query(
      `INSERT INTO messages (id, conversation_id, sender_id, text, media_urls, message_type, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, 'text', false, CURRENT_TIMESTAMP)
       RETURNING *`,
      [messageId, conversationId, userId, text || null, mediaUrls || []]
    );

    // Update conversation
    await query(
      `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversationId]
    );

    res.status(201).json({
      message: result.rows[0]
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================================
// DELETE CONVERSATION - Delete/archive conversation
// ============================================================================
router.delete('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    // Verify participant
    const result = await query(
      `SELECT user_1_id, user_2_id FROM conversations WHERE id = $1`,
      [conversationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { user_1_id, user_2_id } = result.rows[0];

    if (userId !== user_1_id && userId !== user_2_id) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // Soft delete - mark as inactive
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

export default router;