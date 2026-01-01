// ============================================================================
// src/socket/handlers/localMatchHandler.ts
// Distance-based matching for Local Mode - FIXED VERSION
// ============================================================================

import { Server as SocketServer } from 'socket.io';
import { query } from '../../config/database.js';
import { setRedis, getRedis, deleteRedis } from '../../config/redis.js';
import { CustomSocket } from '../../types/customSocket.js';
import { calculateDistance } from '../../utils/distance.js';

interface LocalMatchPreferences {
  mode: 'chat' | 'video';
  maxDistance: number; // in kilometers
  ageRange: [number, number];
  genderPreference: 'male' | 'female' | 'other' | 'all';
}

interface QueuedLocalUser {
  userId: string;
  socketId: string;
  latitude: number;
  longitude: number;
  preferences: LocalMatchPreferences;
  timestamp: number;
}

const localMatchingQueue: QueuedLocalUser[] = [];
const activeLocalMatches = new Map<string, string>(); // userId -> partnerId

export const localMatchHandler = (io: SocketServer, socket: CustomSocket) => {
  const userId = socket.userId;

  // ============================================================================
  // START LOCAL SEARCHING - User starts looking for nearby match
  // ============================================================================
  socket.on('local_match:start_searching', async (preferences: LocalMatchPreferences) => {
    try {
      console.log(`🗺️ User ${userId} started LOCAL search:`, preferences);

      // ✅ CRITICAL: Clean up any stale active matches first
      if (activeLocalMatches.has(userId)) {
        const stalePartnerId = activeLocalMatches.get(userId);
        console.log(`⚠️ Cleaning up stale match for ${userId} (partner: ${stalePartnerId})`);
        activeLocalMatches.delete(userId);
        if (stalePartnerId) {
          activeLocalMatches.delete(stalePartnerId);
        }
      }

      // CHECK IF ALREADY IN QUEUE
      const alreadyInQueue = localMatchingQueue.some(q => q.userId === userId);
      if (alreadyInQueue) {
        console.log(`⚠️ User ${userId} already in local queue`);
        socket.emit('local_match:searching', {
          message: 'Already searching locally...',
          queuePosition: localMatchingQueue.findIndex(q => q.userId === userId) + 1
        });
        return;
      }

      // Get user location
      const locationResult = await query(
        `SELECT latitude, longitude FROM locations WHERE user_id = $1`,
        [userId]
      );

      if (locationResult.rows.length === 0) {
        socket.emit('error', { message: 'Please share your location first to use Local Mode' });
        return;
      }

      const { latitude, longitude } = locationResult.rows[0];

      // Get user info
      const userResult = await query(
        `SELECT id, name, age, gender, avatar_url, bio, interests 
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        socket.emit('error', { message: 'User not found' });
        return;
      }

      const user = userResult.rows[0];

      // Add to local queue
      const queuedUser: QueuedLocalUser = {
        userId,
        socketId: socket.id,
        latitude,
        longitude,
        preferences,
        timestamp: Date.now()
      };

      localMatchingQueue.push(queuedUser);

      // Store in Redis
      await setRedis(
        `local_matching:${userId}`,
        JSON.stringify({ ...queuedUser, user }),
        300 // 5 minutes
      );

      // Confirm searching
      socket.emit('local_match:searching', {
        message: 'Searching for nearby match...',
        queuePosition: localMatchingQueue.length
      });

      console.log(`✅ Added to local queue. Total: ${localMatchingQueue.length}`);

      // Try to find match
      await findLocalMatch(userId, latitude, longitude, preferences, user);
    } catch (error) {
      console.error('Start local searching error:', error);
      socket.emit('error', { message: 'Failed to start searching' });
    }
  });

  // ============================================================================
  // FIND LOCAL MATCH - Distance-based algorithm
  // ============================================================================
  const findLocalMatch = async (
    searchingUserId: string,
    userLat: number,
    userLng: number,
    preferences: LocalMatchPreferences,
    searchingUser: any
  ) => {
    try {
      // Filter queue for compatible users within distance
      const compatibleUsers = localMatchingQueue.filter((queued) => {
        if (queued.userId === searchingUserId) return false;
        if (activeLocalMatches.has(queued.userId)) return false;
        if (queued.preferences.mode !== preferences.mode) return false;

        // Calculate distance
        const distance = calculateDistance(
          userLat,
          userLng,
          queued.latitude,
          queued.longitude
        );

        // Check if within both users' distance preferences
        const withinSearcherRange = distance <= preferences.maxDistance;
        const withinPartnerRange = distance <= queued.preferences.maxDistance;

        return withinSearcherRange && withinPartnerRange;
      });

      if (compatibleUsers.length === 0) {
        console.log(`📍 No nearby compatible users found for ${searchingUserId}`);
        return;
      }

      console.log(`🔍 Found ${compatibleUsers.length} nearby potential matches`);

      // Sort by distance (closest first)
      compatibleUsers.sort((a, b) => {
        const distA = calculateDistance(userLat, userLng, a.latitude, a.longitude);
        const distB = calculateDistance(userLat, userLng, b.latitude, b.longitude);
        return distA - distB;
      });

      // Check compatibility with closest user
      for (const matchedQueued of compatibleUsers) {
        const matchedUserResult = await query(
          `SELECT id, name, age, gender, avatar_url, bio, interests 
           FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [matchedQueued.userId]
        );

        if (matchedUserResult.rows.length === 0) {
          removeFromLocalQueue(matchedQueued.userId);
          continue;
        }

        const matchedUser = matchedUserResult.rows[0];

        // Gender preference check
        if (
          preferences.genderPreference !== 'all' &&
          preferences.genderPreference !== matchedUser.gender
        ) {
          console.log(`❌ Gender mismatch`);
          continue;
        }

        if (
          matchedQueued.preferences.genderPreference !== 'all' &&
          matchedQueued.preferences.genderPreference !== searchingUser.gender
        ) {
          console.log(`❌ Partner gender preference mismatch`);
          continue;
        }

        // Age range check
        if (
          matchedUser.age < preferences.ageRange[0] ||
          matchedUser.age > preferences.ageRange[1]
        ) {
          console.log(`❌ Age out of range`);
          continue;
        }

        if (
          searchingUser.age < matchedQueued.preferences.ageRange[0] ||
          searchingUser.age > matchedQueued.preferences.ageRange[1]
        ) {
          console.log(`❌ Searcher age out of partner's range`);
          continue;
        }

        // Check if blocked
        const blockResult = await query(
          `SELECT id FROM user_blocks 
           WHERE (user_id = $1 AND blocked_user_id = $2)
           OR (user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
          [searchingUserId, matchedQueued.userId]
        );

        if (blockResult.rows.length > 0) {
          console.log(`❌ Users are blocked`);
          continue;
        }

        // Calculate actual distance for display
        const distance = calculateDistance(
          userLat,
          userLng,
          matchedQueued.latitude,
          matchedQueued.longitude
        );

        // LOCAL MATCH FOUND!
        console.log(`✨ Local match found: ${searchingUserId} <-> ${matchedQueued.userId} (${distance.toFixed(1)} km away)`);

        // Remove both from queue
        removeFromLocalQueue(searchingUserId);
        removeFromLocalQueue(matchedQueued.userId);

        // Create match ID
        const matchId = `local_match_${Date.now()}_${searchingUserId}_${matchedQueued.userId}`;

        // Store active match
        activeLocalMatches.set(searchingUserId, matchedQueued.userId);
        activeLocalMatches.set(matchedQueued.userId, searchingUserId);

        // Create conversation
        const convResult = await query(
          `SELECT id, chat_mode FROM conversations 
           WHERE ((user_1_id = $1 AND user_2_id = $2) 
           OR (user_1_id = $2 AND user_2_id = $1))
           AND is_active = true`,
          [searchingUserId, matchedQueued.userId]
        );

        let conversationId;
        if (convResult.rows.length > 0) {
          conversationId = convResult.rows[0].id;
          console.log(`📝 Using existing conversation: ${conversationId}`);
        } else {
          const newConvResult = await query(
            `INSERT INTO conversations (user_1_id, user_2_id, chat_mode, is_active, created_at, last_message_at)
             VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             RETURNING id`,
            [searchingUserId, matchedQueued.userId, preferences.mode]
          );
          conversationId = newConvResult.rows[0].id;
          console.log(`📝 Created new conversation: ${conversationId}`);
        }

        // Store in Redis
        await setRedis(`local_match:${matchId}`, JSON.stringify({
          user1: searchingUserId,
          user2: matchedQueued.userId,
          conversationId,
          mode: preferences.mode,
          distance: distance.toFixed(1),
          createdAt: new Date()
        }), 3600);

        // Join both users to conversation room
        socket.join(conversationId);
        
        // Prepare match data with distance
        const matchDataForSearcher = {
          matchId,
          conversationId,
          distance: `${distance.toFixed(1)} km`,
          partner: {
            id: matchedUser.id,
            name: matchedUser.name,
            age: matchedUser.age,
            avatar: matchedUser.avatar_url,
            avatar_url: matchedUser.avatar_url,
            bio: matchedUser.bio,
            interests: matchedUser.interests,
            status: 'online',
            location: {
              distance: `${distance.toFixed(1)} km away`
            }
          },
          mode: preferences.mode
        };

        const matchDataForPartner = {
          matchId,
          conversationId,
          distance: `${distance.toFixed(1)} km`,
          partner: {
            id: searchingUser.id,
            name: searchingUser.name,
            age: searchingUser.age,
            avatar: searchingUser.avatar_url,
            avatar_url: searchingUser.avatar_url,
            bio: searchingUser.bio,
            interests: searchingUser.interests,
            status: 'online',
            location: {
              distance: `${distance.toFixed(1)} km away`
            }
          },
          mode: preferences.mode
        };

        // ✅ CRITICAL FIX: Emit to BOTH users using their socket IDs
        console.log(`🔔 Emitting local_match:found to searcher ${searchingUserId} (socket: ${socket.id})`);
        socket.emit('local_match:found', matchDataForSearcher);

        console.log(`🔔 Emitting local_match:found to partner ${matchedQueued.userId} (socket: ${matchedQueued.socketId})`);
        io.to(matchedQueued.socketId).emit('local_match:found', matchDataForPartner);

        // Join partner to conversation room
        io.in(matchedQueued.socketId).socketsJoin(conversationId);

        return; // Match found, exit
      }

      console.log(`⚠️ No compatible nearby matches after checking all candidates`);
    } catch (error) {
      console.error('Find local match error:', error);
    }
  };

  // ============================================================================
  // STOP LOCAL SEARCHING
  // ============================================================================
  socket.on('local_match:stop_searching', async () => {
    try {
      removeFromLocalQueue(userId);
      await deleteRedis(`local_matching:${userId}`);
      
      // ✅ CRITICAL: Also remove from active matches when canceling
      const partnerId = activeLocalMatches.get(userId);
      if (partnerId) {
        activeLocalMatches.delete(userId);
        activeLocalMatches.delete(partnerId);
        console.log(`✅ Removed active match: ${userId} <-> ${partnerId}`);
        
        // Notify partner
        io.to(partnerId).emit('local_match:partner_left', {
          message: 'Partner canceled the search'
        });
      }
      
      socket.emit('local_match:stopped', { message: 'Stopped searching' });
      console.log(`📍 User ${userId} stopped local searching`);
    } catch (error) {
      console.error('Stop local searching error:', error);
    }
  });

  // ============================================================================
  // SKIP LOCAL MATCH
  // ============================================================================
  socket.on('local_match:skip', async (matchId: string) => {
    try {
      const partnerId = activeLocalMatches.get(userId);
      if (!partnerId) {
        console.log(`⚠️ No active match to skip for ${userId}`);
        return;
      }

      console.log(`⏭️ User ${userId} skipped local match with ${partnerId}`);

      // Remove both from active matches
      activeLocalMatches.delete(userId);
      activeLocalMatches.delete(partnerId);

      // Get partner's socket and notify
      const partnerSocket = Array.from(io.sockets.sockets.values()).find(
        s => (s as CustomSocket).userId === partnerId
      );

      if (partnerSocket) {
        partnerSocket.emit('local_match:partner_skipped', {
          message: 'Partner skipped the match'
        });
      }

      socket.emit('local_match:skipped', { message: 'Match skipped' });
    } catch (error) {
      console.error('Skip local match error:', error);
    }
  });

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================
  const removeFromLocalQueue = (targetUserId: string) => {
    const index = localMatchingQueue.findIndex((q) => q.userId === targetUserId);
    if (index !== -1) {
      localMatchingQueue.splice(index, 1);
      console.log(`✅ Removed from local queue. Remaining: ${localMatchingQueue.length}`);
    }
  };

  // ============================================================================
  // CLEANUP
  // ============================================================================
  socket.on('disconnect', async () => {
    try {
      console.log(`🔌 User ${userId} disconnecting...`);
      
      // Remove from queue
      removeFromLocalQueue(userId);
      await deleteRedis(`local_matching:${userId}`);

      // Handle active match cleanup
      const partnerId = activeLocalMatches.get(userId);
      if (partnerId) {
        console.log(`💔 Cleaning up active match: ${userId} <-> ${partnerId}`);
        activeLocalMatches.delete(userId);
        activeLocalMatches.delete(partnerId);

        // Find partner's socket and notify
        const partnerSocket = Array.from(io.sockets.sockets.values()).find(
          s => (s as CustomSocket).userId === partnerId
        );

        if (partnerSocket) {
          partnerSocket.emit('local_match:partner_left', {
            message: 'Partner disconnected'
          });
        }
      }
      
      console.log(`✅ Cleanup complete for ${userId}`);
    } catch (error) {
      console.error('Local match disconnect cleanup error:', error);
    }
  });
};

export default localMatchHandler;