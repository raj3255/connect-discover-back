import { Server as SocketServer, Socket } from 'socket.io';
import { Pool } from 'pg';
import { CustomSocket } from '../../types/customSocket';

export const typingHandler = (io: SocketServer, socket: CustomSocket, db: Pool) => {
  const userId = socket.userId;
  const typingTimeouts = new Map<string, NodeJS.Timeout>();

  // ============================================================================
  // START TYPING - User starts typing
  // ============================================================================
  // Broadcast typing indicator to conversation
  // Auto-stop after 5 seconds of no activity

  socket.on('typing:start', async (conversationId: string) => {
    try {
      const timeoutKey = `${conversationId}:${userId}`;

      // Clear existing timeout
      if (typingTimeouts.has(timeoutKey)) {
        clearTimeout(typingTimeouts.get(timeoutKey)!);
      }

      // Broadcast to conversation (except sender)
      socket.to(`conversation:${conversationId}`).emit('typing:user_typing', {
        conversationId,
        userId
      });

      // Auto-stop after 5 seconds
      const timeout = setTimeout(async () => {
        socket.to(`conversation:${conversationId}`).emit('typing:user_stopped', {
          conversationId,
          userId
        });
        typingTimeouts.delete(timeoutKey);
      }, 5000);

      typingTimeouts.set(timeoutKey, timeout);
    } catch (error) {
      console.error('Typing start error:', error);
    }
  });

  // ============================================================================
  // STOP TYPING - User stops typing
  // ============================================================================

  socket.on('typing:stop', async (conversationId: string) => {
    try {
      const timeoutKey = `${conversationId}:${userId}`;

      // Clear timeout
      if (typingTimeouts.has(timeoutKey)) {
        clearTimeout(typingTimeouts.get(timeoutKey)!);
        typingTimeouts.delete(timeoutKey);
      }

      // Broadcast stop typing
      socket.to(`conversation:${conversationId}`).emit('typing:user_stopped', {
        conversationId,
        userId
      });
    } catch (error) {
      console.error('Typing stop error:', error);
    }
  });

  // ============================================================================
  // CLEANUP - Clear timeouts on disconnect
  // ============================================================================

  socket.on('disconnect', async () => {
    // Clear all typing timeouts
    for (const [key, timeout] of typingTimeouts.entries()) {
      clearTimeout(timeout);
      const [conversationId] = key.split(':');

      io.to(`conversation:${conversationId}`).emit('typing:user_stopped', {
        conversationId,
        userId
      });
    }

    typingTimeouts.clear();
  });
};

export default typingHandler;