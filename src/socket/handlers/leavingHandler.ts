// src/socket/handlers/leavingHandler.ts
import { Server as SocketServer, Socket } from 'socket.io';
import { query } from '../../config/database.js';
import { CustomSocket } from '../../types/customSocket';

export const leavingHandler = (io: SocketServer, socket: CustomSocket) => {
  const userId = socket.userId;

  // ============================================================================
  // LEAVE CONVERSATION - User manually leaves a conversation
  // ============================================================================
  // Conversations are 1:1 (conversations.user_1_id / user_2_id). There is no
  // participant table, so membership is verified directly against the
  // conversation row, and "leaving" simply removes the socket from the room
  // and notifies the other participant.

  socket.on('conversation:leave', async (conversationId: string) => {
    try {
      // Verify user is one of the two participants
      const convResult = await query(
        `SELECT user_1_id, user_2_id FROM conversations WHERE id = $1`,
        [conversationId]
      );

      if (convResult.rows.length === 0) {
        socket.emit('error', { message: 'Conversation not found' });
        return;
      }

      const { user_1_id, user_2_id } = convResult.rows[0];
      if (userId !== user_1_id && userId !== user_2_id) {
        socket.emit('error', {
          message: 'You are not a participant in this conversation'
        });
        return;
      }

      // Remove user from socket room
      socket.leave(`conversation:${conversationId}`);

      // Get user name for notification
      const userResult = await query(
        `SELECT name FROM users WHERE id = $1`,
        [userId]
      );
      const userName = userResult.rows[0]?.name || 'User';

      // Notify other participant that user left
      socket.to(`conversation:${conversationId}`).emit('user:left', {
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
  // Notify every conversation room this socket had joined that the user
  // disconnected. Room membership is read from socket.rooms (no DB tracking).
  // Typing-indicator cleanup is owned by typingHandler's own disconnect handler.

  socket.on('disconnect', async (reason: string) => {
    try {
      console.log(`User ${userId} disconnected. Reason: ${reason}`);

      // socket.rooms includes the socket's own id plus any joined rooms.
      const conversationRooms = Array.from(socket.rooms).filter((room) =>
        room.startsWith('conversation:')
      );

      for (const room of conversationRooms) {
        const conversationId = room.slice('conversation:'.length);

        socket.to(room).emit('user:disconnected', {
          conversationId,
          userId,
          timestamp: new Date(),
          reason
        });

        console.log(
          `Notified conversation ${conversationId} about user ${userId} disconnect`
        );
      }
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
