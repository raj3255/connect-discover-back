import { Server as SocketServer, Socket } from 'socket.io';
import { Pool } from 'pg';
import { query } from '../../config/database.js';
import { setRedis, getRedis, deleteRedis } from '../../config/redis.js';
import { CustomSocket } from '../../types/customSocket';

export const statusHandler = (io: SocketServer, socket: CustomSocket, db: Pool) => {
  const userId = socket.userId;

  // ============================================================================
  // SET ONLINE - User comes online
  // ============================================================================
  // Called on connection, updates DB and Redis
  // Notifies others user is online

  const setOnline = async () => {
    try {
      // Update database
      await query(
        `UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [userId]
      );

      // Cache in Redis
      await setRedis(`user:${userId}:status`, 'online', 3600);
      await setRedis(`user:${userId}:last_activity`, new Date().toISOString(), 3600);

      // Broadcast to subscribed users
      io.emit('status:user_online', {
        userId,
        status: 'online'
      });

      console.log(`User ${userId} is online`);
    } catch (error) {
      console.error('Error setting online:', error);
    }
  };

  // ============================================================================
  // SET OFFLINE - User goes offline
  // ============================================================================
  // Called on disconnect with 5 second grace period
  // Notifies others user is offline

  const setOffline = async () => {
    try {
      const lastSeen = new Date();

      // Update database
      await query(
        `UPDATE users SET updated_at = $1 WHERE id = $2`,
        [lastSeen, userId]
      );

      // Update Redis
      await setRedis(`user:${userId}:status`, 'offline', 3600);
      await setRedis(`user:${userId}:last_activity`, lastSeen.toISOString(), 3600);

      // Broadcast offline status
      io.emit('status:user_offline', {
        userId,
        lastSeen
      });

      console.log(`User ${userId} is offline`);
    } catch (error) {
      console.error('Error setting offline:', error);
    }
  };

  // ============================================================================
  // HEARTBEAT - Keep user alive
  // ============================================================================
  // Client sends every 20 seconds to keep session active
  // Prevents idle timeout

  socket.on('heartbeat', async () => {
    try {
      await setRedis(`user:${userId}:last_activity`, new Date().toISOString(), 3600);
    } catch (error) {
      console.error('Heartbeat error:', error);
    }
  });

  // ============================================================================
  // UPDATE STATUS - Change status (online/idle/offline)
  // ============================================================================

  socket.on('status:update', async (status: string) => {
    try {
      const validStatuses = ['online', 'idle', 'offline'];
      if (!validStatuses.includes(status)) return;

      await setRedis(`user:${userId}:status`, status, 3600);

      // Broadcast status change
      io.emit('status:user_online', {
        userId,
        status
      });
    } catch (error) {
      console.error('Status update error:', error);
    }
  });

  // ============================================================================
  // SUBSCRIBE TO STATUS - Get updates about specific users
  // ============================================================================

  socket.on('status:subscribe', async (userIds: string[]) => {
    try {
      // Get current status of all requested users
      const statuses = await Promise.all(
        userIds.map(async (targetId) => {
          const status = await getRedis(`user:${targetId}:status`) || 'offline';
          const lastActivity = await getRedis(`user:${targetId}:last_activity`);

          return {
            userId: targetId,
            status,
            lastActivity: lastActivity || null
          };
        })
      );

      socket.emit('status:bulk_status', statuses);
    } catch (error) {
      console.error('Subscribe status error:', error);
    }
  });

  // ============================================================================
  // INITIALIZATION & CLEANUP
  // ============================================================================

  // Set online on connection
  setOnline();

  // Handle disconnect with grace period
  socket.on('disconnect', async () => {
    // Wait 5 seconds to see if user reconnects
    setTimeout(async () => {
      const stillConnected = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (!stillConnected || stillConnected.size === 0) {
        await setOffline();
      }
    }, 5000);
  });
};

export default statusHandler;