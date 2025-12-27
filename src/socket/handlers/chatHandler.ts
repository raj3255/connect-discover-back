import { Server as SocketServer } from 'socket.io';
import { query } from '../../config/database.js';
import { CustomSocket } from '../../types/customSocket.js';

export const chatHandler = (io: SocketServer, socket: CustomSocket, db: any) => {
  const userId = socket.userId;

  // ============================================================================
  // JOIN CHAT - User enters conversation
  // ============================================================================
  socket.on('join_chat', async (conversationId: string) => {
    try {
      // Join room
      socket.join(`conversation:${conversationId}`);
      console.log(`User ${userId} joined conversation ${conversationId}`);

      // Mark messages as read
      await query(
        `UPDATE messages SET is_read = true, read_at = CURRENT_TIMESTAMP 
         WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false`,
        [conversationId, userId]
      );

      socket.emit('chat:joined', {
        conversationId,
        message: 'Joined conversation'
      });
    } catch (error) {
      console.error('Join chat error:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  // ============================================================================
  // SEND MESSAGE - Real-time message delivery
  // ============================================================================
  socket.on('send_message', async (data) => {
    try {
      const { conversationId, text, mediaUrls, messageType = 'text' } = data;

      // Validation
      if (!conversationId || !text) {
        socket.emit('error', { message: 'Missing conversationId or text' });
        return;
      }

      console.log(`Sending message to ${conversationId}:`, text);

      // Insert message into database
      const messageResult = await query(
        `INSERT INTO messages (conversation_id, sender_id, text, media_urls, message_type, is_read)
         VALUES ($1, $2, $3, $4, $5, false)
         RETURNING id, created_at`,
        [conversationId, userId, text, mediaUrls || [], messageType]
      );

      if (!messageResult.rows[0]) {
        throw new Error('Failed to insert message');
      }

      const message = messageResult.rows[0];

      // Update conversation last_message_at
      await query(
        `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversationId]
      );

      // Broadcast to conversation room
      io.to(`conversation:${conversationId}`).emit('chat:new_message', {
        id: message.id,
        conversationId,
        senderId: userId,
        text,
        mediaUrls: mediaUrls || [],
        messageType,
        isRead: false,
        createdAt: message.created_at
      });

      console.log(`Message ${message.id} sent successfully`);
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { 
        message: 'Failed to send message',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ============================================================================
  // LEAVE CHAT - User leaves conversation
  // ============================================================================
  socket.on('leave_chat', (conversationId: string) => {
    socket.leave(`conversation:${conversationId}`);
    console.log(`User ${userId} left conversation ${conversationId}`);
  });

  // ============================================================================
  // LISTEN FOR MESSAGES
  // ============================================================================
  socket.on('chat:new_message', (message) => {
    console.log('New message received:', message);
  });
};

export default chatHandler;