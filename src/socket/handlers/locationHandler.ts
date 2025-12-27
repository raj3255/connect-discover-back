import { Server as SocketServer, Socket } from 'socket.io';
import { Pool } from 'pg';
import { query } from '../../config/database.js';
import { setRedis, getRedis } from '../../config/redis.js';
import { calculateDistance } from '../../utils/distance.js';
import { CustomSocket } from '../../types/customSocket';

export const locationHandler = (io: SocketServer, socket: CustomSocket, db: Pool) => {
  const userId = socket.userId;
  let nearbySubscription: number | null = null;
  let updateInterval: NodeJS.Timeout | null = null;

  // ============================================================================
  // UPDATE LOCATION - User shares GPS location
  // ============================================================================
  // Stores in Redis (fast) and PostgreSQL (persistent)
  // Notifies subscribed users of location change

  socket.on('location:update', async (data) => {
    const { latitude, longitude, accuracy } = data;

    try {
      if (!latitude || !longitude) {
        socket.emit('error', { message: 'Latitude and longitude required' });
        return;
      }

      // Validate coordinates
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        socket.emit('error', { message: 'Invalid coordinates' });
        return;
      }

      // Update database
      const existingResult = await query(
        `SELECT id FROM locations WHERE user_id = $1`,
        [userId]
      );

      if (existingResult.rows.length > 0) {
        await query(
          `UPDATE locations SET latitude = $1, longitude = $2, updated_at = CURRENT_TIMESTAMP 
           WHERE user_id = $3`,
          [latitude, longitude, userId]
        );
      } else {
        await query(
          `INSERT INTO locations (user_id, latitude, longitude, updated_at) 
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          [userId, latitude, longitude]
        );
      }

      // Cache in Redis (30 minutes)
      await setRedis(
        `location:${userId}`,
        JSON.stringify({ latitude, longitude, accuracy, updatedAt: new Date() }),
        1800
      );

      // If subscribed to nearby updates, recalculate
      if (nearbySubscription) {
        await sendNearbyUsers(nearbySubscription);
      }

      console.log(`Location updated for user ${userId}: ${latitude}, ${longitude}`);
    } catch (error) {
      console.error('Location update error:', error);
      socket.emit('error', { message: 'Failed to update location' });
    }
  });

  // ============================================================================
  // SUBSCRIBE TO NEARBY USERS - Get live nearby user updates
  // ============================================================================
  // Refreshes every 30 seconds while subscribed

  socket.on('location:subscribe_nearby', async (radius: number) => {
    try {
      nearbySubscription = radius;
      await sendNearbyUsers(radius);

      // Update every 30 seconds
      if (updateInterval) clearInterval(updateInterval);
      updateInterval = setInterval(async () => {
        if (nearbySubscription) {
          await sendNearbyUsers(nearbySubscription);
        }
      }, 30000);
    } catch (error) {
      console.error('Subscribe nearby error:', error);
      socket.emit('error', { message: 'Failed to subscribe' });
    }
  });

  // ============================================================================
  // UNSUBSCRIBE FROM NEARBY - Stop receiving nearby updates
  // ============================================================================

  socket.on('location:unsubscribe_nearby', () => {
    nearbySubscription = null;
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });

  // ============================================================================
  // HELPER: SEND NEARBY USERS
  // ============================================================================

  const sendNearbyUsers = async (radius: number) => {
    try {
      // Get user's location
      const userLocResult = await query(
        `SELECT latitude, longitude FROM locations WHERE user_id = $1`,
        [userId]
      );

      if (userLocResult.rows.length === 0) {
        socket.emit('error', { message: 'Please share your location first' });
        return;
      }

      const { latitude: userLat, longitude: userLng } = userLocResult.rows[0];

      // Get all users with locations (except blocked)
      const result = await query(
        `SELECT u.id, u.name, u.avatar_url, u.is_verified,
                l.latitude, l.longitude
         FROM users u
         JOIN locations l ON u.id = l.user_id
         WHERE u.id != $1 
         AND u.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users 
           WHERE (blocker_id = $1 AND blocked_id = u.id) 
           OR (blocker_id = u.id AND blocked_id = $1)
         )
         LIMIT 100`,
        [userId]
      );

      // Calculate distances and filter
      const nearbyUsers = result.rows
        .map((user) => {
          const distance = calculateDistance(
            userLat,
            userLng,
            user.latitude,
            user.longitude
          );
          return { ...user, distance: Math.round(distance * 100) / 100 };
        })
        .filter((user) => user.distance <= radius)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 50);

      socket.emit('location:nearby_users', {
        users: nearbyUsers,
        count: nearbyUsers.length,
        userLocation: { latitude: userLat, longitude: userLng }
      });
    } catch (error) {
      console.error('Send nearby users error:', error);
      socket.emit('error', { message: 'Failed to get nearby users' });
    }
  };

  // ============================================================================
  // CLEANUP - Stop updates on disconnect
  // ============================================================================

  socket.on('disconnect', () => {
    nearbySubscription = null;
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });
};

export default locationHandler;