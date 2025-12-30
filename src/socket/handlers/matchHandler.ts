// ============================================================================
// src/socket/handlers/matchHandler.ts
// FIXED: Users join conversation room for WebRTC signaling
// ============================================================================

import { Server as SocketServer } from 'socket.io';
import { query } from '../../config/database.js';
import { setRedis, getRedis, deleteRedis } from '../../config/redis.js';
import { CustomSocket } from '../../types/customSocket.js';

interface MatchPreferences {
  mode: 'chat' | 'video';
  ageRange: [number, number];
  genderPreference: 'male' | 'female' | 'other' | 'all';
}

interface QueuedUser {
  userId: string;
  socketId: string;
  preferences: MatchPreferences;
  timestamp: number;
}

const matchingQueue: QueuedUser[] = [];
const activeMatches = new Map<string, string>(); // userId -> partnerId

export const matchHandler = (io: SocketServer, socket: CustomSocket) => {
  const userId = socket.userId;

  // ============================================================================
  // START SEARCHING - User starts looking for match
  // ============================================================================
  socket.on('match:start_searching', async (preferences: MatchPreferences) => {
    try {
      console.log(`User ${userId} started searching with preferences:`, preferences);

      // CHECK IF ALREADY IN QUEUE - PREVENT DUPLICATES
      const alreadyInQueue = matchingQueue.some(q => q.userId === userId);
      if (alreadyInQueue) {
        console.log(`⚠️ User ${userId} already in queue, ignoring duplicate request`);
        socket.emit('match:searching', {
          message: 'Already searching...',
          queuePosition: matchingQueue.findIndex(q => q.userId === userId) + 1
        });
        return;
      }

      // CHECK IF ALREADY MATCHED
      if (activeMatches.has(userId)) {
        console.log(`⚠️ User ${userId} already has an active match`);
        socket.emit('error', { message: 'You already have an active match' });
        return;
      }

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

      // Add to queue
      const queuedUser: QueuedUser = {
        userId,
        socketId: socket.id,
        preferences,
        timestamp: Date.now()
      };

      matchingQueue.push(queuedUser);

      // Store in Redis
      await setRedis(
        `matching:${userId}`,
        JSON.stringify({ ...queuedUser, user }),
        300 // 5 minutes
      );

      // Confirm searching
      socket.emit('match:searching', {
        message: 'Searching for match...',
        queuePosition: matchingQueue.length
      });

      console.log(`✅ Added to queue. Total in queue: ${matchingQueue.length}`);

      // Try to find match
      await findMatch(userId, preferences, user);
    } catch (error) {
      console.error('Start searching error:', error);
      socket.emit('error', { message: 'Failed to start searching' });
    }
  });

  // ============================================================================
  // FIND MATCH - Algorithm to find compatible user
  // ============================================================================
  const findMatch = async (
    searchingUserId: string,
    preferences: MatchPreferences,
    searchingUser: any
  ) => {
    try {
      // Filter queue for compatible users
      const compatibleUsers = matchingQueue.filter((queued) => {
        if (queued.userId === searchingUserId) return false;
        if (activeMatches.has(queued.userId)) return false;
        if (queued.preferences.mode !== preferences.mode) return false;

        return true;
      });

      if (compatibleUsers.length === 0) {
        console.log(`No compatible users found for ${searchingUserId}`);
        return;
      }

      console.log(`🔍 Found ${compatibleUsers.length} potential matches for ${searchingUserId}`);

      // Get first compatible user and fetch their data
      for (const matchedQueued of compatibleUsers) {
        const matchedUserResult = await query(
          `SELECT id, name, age, gender, avatar_url, bio, interests 
           FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [matchedQueued.userId]
        );

        if (matchedUserResult.rows.length === 0) {
          removeFromQueue(matchedQueued.userId);
          continue;
        }

        const matchedUser = matchedUserResult.rows[0];

        // Gender preference check
        if (
          preferences.genderPreference !== 'all' &&
          preferences.genderPreference !== matchedUser.gender
        ) {
          console.log(`❌ Gender mismatch: ${preferences.genderPreference} != ${matchedUser.gender}`);
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
          console.log(`❌ Age out of range: ${matchedUser.age} not in [${preferences.ageRange[0]}, ${preferences.ageRange[1]}]`);
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

        // MATCH FOUND!
        console.log(`✨ Match found: ${searchingUserId} <-> ${matchedQueued.userId}`);

        // Remove both from queue IMMEDIATELY
        removeFromQueue(searchingUserId);
        removeFromQueue(matchedQueued.userId);

        // Create match ID
        const matchId = `match_${Date.now()}_${searchingUserId}_${matchedQueued.userId}`;

        // Store active match
        activeMatches.set(searchingUserId, matchedQueued.userId);
        activeMatches.set(matchedQueued.userId, searchingUserId);

        // Create conversation if doesn't exist
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
          // Create new conversation
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
        await setRedis(`match:${matchId}`, JSON.stringify({
          user1: searchingUserId,
          user2: matchedQueued.userId,
          conversationId,
          mode: preferences.mode,
          createdAt: new Date()
        }), 3600);

        // ✅ JOIN BOTH USERS TO CONVERSATION ROOM FOR WEBRTC SIGNALING
        socket.join(conversationId);
        console.log(`✅ User ${searchingUserId} joined room ${conversationId}`);

        // Find and join partner sockets to the room
        const partnerSockets = await io.in(`user:${matchedQueued.userId}`).fetchSockets();
        partnerSockets.forEach(partnerSocket => {
          partnerSocket.join(conversationId);
          console.log(`✅ Partner ${matchedQueued.userId} joined room ${conversationId}`);
        });

        // Prepare match data
        const matchDataForSearcher = {
          matchId,
          conversationId,
          partner: {
            id: matchedUser.id,
            name: matchedUser.name,
            age: matchedUser.age,
            avatar: matchedUser.avatar_url,
            avatar_url: matchedUser.avatar_url,
            bio: matchedUser.bio,
            interests: matchedUser.interests,
            status: 'online'
          },
          mode: preferences.mode
        };

        const matchDataForPartner = {
          matchId,
          conversationId,
          partner: {
            id: searchingUser.id,
            name: searchingUser.name,
            age: searchingUser.age,
            avatar: searchingUser.avatar_url,
            avatar_url: searchingUser.avatar_url,
            bio: searchingUser.bio,
            interests: searchingUser.interests,
            status: 'online'
          },
          mode: preferences.mode
        };

        // Notify searching user
        console.log(`🔔 Emitting match:found to searching user ${searchingUserId}`);
        socket.emit('match:found', matchDataForSearcher);

        // Notify partner
        console.log(`📡 Found ${partnerSockets.length} socket(s) for partner ${matchedQueued.userId}`);

        if (partnerSockets.length > 0) {
          console.log(`🔔 Emitting match:found to partner ${matchedQueued.userId}`);
          partnerSockets[0].emit('match:found', matchDataForPartner);
        }

        return; // Match found, exit
      }

      console.log(`⚠️ No compatible matches after checking all candidates for ${searchingUserId}`);
    } catch (error) {
      console.error('Find match error:', error);
    }
  };

  // ============================================================================
  // STOP SEARCHING
  // ============================================================================
  socket.on('match:stop_searching', async () => {
    try {
      removeFromQueue(userId);
      await deleteRedis(`matching:${userId}`);
      socket.emit('match:stopped', { message: 'Stopped searching' });
      console.log(`User ${userId} stopped searching`);
    } catch (error) {
      console.error('Stop searching error:', error);
    }
  });

  // ============================================================================
  // SKIP MATCH - Find a new match without accepting current one
  // ============================================================================
  socket.on('match:skip', async (partnerId: string) => {
    try {
      console.log(`User ${userId} skipped match with ${partnerId}`);
      
      // Remove from active matches
      activeMatches.delete(userId);
      activeMatches.delete(partnerId);
      
      // Notify partner they were skipped
      const partnerSockets = await io.in(`user:${partnerId}`).fetchSockets();
      if (partnerSockets.length > 0) {
        partnerSockets[0].emit('match:partner_skipped', {
          message: 'Partner skipped the match'
        });
      }
      
      socket.emit('match:skipped', { message: 'Match skipped' });
    } catch (error) {
      console.error('Skip match error:', error);
    }
  });

  // ============================================================================
  // ACCEPT MATCH
  // ============================================================================
  socket.on('match:accept', async (matchId: string) => {
    try {
      const partnerId = activeMatches.get(userId);
      if (!partnerId) {
        socket.emit('error', { message: 'No active match' });
        return;
      }

      socket.emit('match:accepted', {
        matchId,
        message: 'Match accepted, starting session...'
      });

      const partnerSockets = await io.in(`user:${partnerId}`).fetchSockets();
      if (partnerSockets.length > 0) {
        partnerSockets[0].emit('match:accepted', {
          matchId,
          message: 'Partner accepted, starting session...'
        });
      }

      // Create room
      const roomId = `match:${matchId}`;
      socket.join(roomId);
      if (partnerSockets.length > 0) {
        partnerSockets[0].join(roomId);
      }

      console.log(`Match ${matchId} accepted`);
    } catch (error) {
      console.error('Accept match error:', error);
    }
  });

  // ============================================================================
  // DECLINE MATCH
  // ============================================================================
  socket.on('match:decline', async (matchId: string) => {
    try {
      const partnerId = activeMatches.get(userId);
      if (!partnerId) return;

      activeMatches.delete(userId);
      activeMatches.delete(partnerId);
      await deleteRedis(`match:${matchId}`);

      const partnerSockets = await io.in(`user:${partnerId}`).fetchSockets();
      if (partnerSockets.length > 0) {
        partnerSockets[0].emit('match:declined', {
          message: 'Partner declined the match'
        });
      }

      console.log(`Match ${matchId} declined`);
    } catch (error) {
      console.error('Decline match error:', error);
    }
  });

  // ============================================================================
  // END SESSION
  // ============================================================================
  socket.on('match:end_session', async () => {
    try {
      const partnerId = activeMatches.get(userId);
      if (!partnerId) return;

      activeMatches.delete(userId);
      activeMatches.delete(partnerId);

      const partnerSockets = await io.in(`user:${partnerId}`).fetchSockets();
      if (partnerSockets.length > 0) {
        partnerSockets[0].emit('match:partner_left', {
          message: 'Partner left the session'
        });
      }

      socket.emit('match:session_ended', { message: 'Session ended' });
      console.log(`User ${userId} ended match session`);
    } catch (error) {
      console.error('End session error:', error);
    }
  });

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================
  const removeFromQueue = (targetUserId: string) => {
    const index = matchingQueue.findIndex((q) => q.userId === targetUserId);
    if (index !== -1) {
      matchingQueue.splice(index, 1);
      console.log(`✅ Removed user ${targetUserId} from queue. Remaining: ${matchingQueue.length}`);
    }
  };

  // ============================================================================
  // CLEANUP
  // ============================================================================
  socket.on('disconnect', async () => {
    try {
      removeFromQueue(userId);
      await deleteRedis(`matching:${userId}`);

      const partnerId = activeMatches.get(userId);
      if (partnerId) {
        activeMatches.delete(userId);
        activeMatches.delete(partnerId);

        const partnerSockets = await io.in(`user:${partnerId}`).fetchSockets();
        if (partnerSockets.length > 0) {
          partnerSockets[0].emit('match:partner_left', {
            message: 'Partner disconnected'
          });
        }
      }
    } catch (error) {
      console.error('Match disconnect cleanup error:', error);
    }
  });
};

export default matchHandler;