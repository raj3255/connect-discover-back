// src/socket/handlers/leavingHandler.ts
import { Server as SocketServer, Socket } from 'socket.io';
import { query } from '../../config/database.js';
import { CustomSocket } from '../../types/customSocket';

export const leavingHandler = (io: SocketServer, socket: CustomSocket) => {
  const userId = socket.userId;

  // ============================================================================
  // LEAVE CONVERSATION - User manually leaves a conversation
  // ============================================================================
  // Remove user from conversation and notify others
  // Update database to mark user as left

  socket.on('conversation:leave', async (conversationId: string) => {
    try {
      // Verify user is participant
      const participantResult = await query(
        `SELECT id FROM conversation_participants 
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId]
      );

      if (participantResult.rows.length === 0) {
        socket.emit('error', {
          message: 'You are not a participant in this conversation'
        });
        return;
      }

      // Remove user from socket room
      socket.leave(`conversation:${conversationId}`);

      // Update database - mark as left and inactive
      await query(
        `UPDATE conversation_participants 
         SET left_at = CURRENT_TIMESTAMP, is_active = false 
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId]
      );

      // Get user name for notification
      const userResult = await query(
        `SELECT name FROM users WHERE id = $1`,
        [userId]
      );

      const userName = userResult.rows[0]?.name || 'User';

      // Notify other participants that user left
      io.to(`conversation:${conversationId}`).emit('user:left', {
        conversationId,
        userId,
        userName,
        timestamp: new Date()
      });

      console.log(`User ${userId} left conversation ${conversationId}`);
    } catch (error) {
      console.error('Leave conversation error:', error);
      socket.emit('error', {
        message: 'Failed to leave conversation'
      });
    }
  });

  // ============================================================================
  // DISCONNECT - Handle user disconnection from socket
  // ============================================================================
  // Mark user as inactive in all conversations
  // Notify participants in each conversation
  // Clean up typing indicators and other real-time data

  socket.on('disconnect', async (reason: string) => {
    try {
      console.log(`User ${userId} disconnected. Reason: ${reason}`);

      // Get all conversations user is currently in
      const conversationsResult = await query(
        `SELECT conversation_id FROM conversation_participants 
         WHERE user_id = $1 AND left_at IS NULL`,
        [userId]
      );

      const conversations = conversationsResult.rows;

      // Mark user as disconnected in all conversations
      if (conversations.length > 0) {
        await query(
          `UPDATE conversation_participants 
           SET left_at = CURRENT_TIMESTAMP, is_active = false, disconnected_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND left_at IS NULL`,
          [userId]
        );

        // Notify in each conversation
        for (const conv of conversations) {
          const conversationId = conv.conversation_id;

          // Emit disconnect event to conversation
          io.to(`conversation:${conversationId}`).emit('user:disconnected', {
            conversationId,
            userId,
            timestamp: new Date(),
            reason
          });

          console.log(
            `Notified participants in conversation ${conversationId} about user ${userId} disconnect`
          );
        }
      }

      // Clean up user's typing indicators in all conversations
      const typingResult = await query(
        `SELECT DISTINCT conversation_id FROM typing_indicators 
         WHERE user_id = $1`,
        [userId]
      );

      if (typingResult.rows.length > 0) {
        for (const row of typingResult.rows) {
          const conversationId = row.conversation_id;
          
          // Delete typing indicator
          await query(
            `DELETE FROM typing_indicators 
             WHERE conversation_id = $1 AND user_id = $2`,
            [conversationId, userId]
          );

          // Notify conversation that user stopped typing
          io.to(`conversation:${conversationId}`).emit('typing:user_stopped', {
            conversationId,
            userId
          });
        }
      }

      console.log(`Cleaned up all data for disconnected user ${userId}`);
    } catch (error) {
      console.error('Disconnect handler error:', error);
    }
  });

  // ============================================================================
  // HANDLE ERRORS
  // ============================================================================

  socket.on('error', (error: Error) => {
    console.error(`Socket error for user ${userId}:`, error);
    socket.emit('error', {
      message: 'An error occurred'
    });
  });
};

export default leavingHandler;