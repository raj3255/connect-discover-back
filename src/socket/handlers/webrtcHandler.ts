// src/socket/handlers/webrtcHandler.ts
// WebRTC Signaling Handler for Video Calls

import { Server as SocketServer, Socket } from 'socket.io';

// Use generic types since WebRTC types are browser-only
interface WebRTCOffer {
  conversationId: string;
  offer: any; // RTCSessionDescriptionInit (browser type)
}

interface WebRTCAnswer {
  conversationId: string;
  answer: any; // RTCSessionDescriptionInit (browser type)
}

interface ICECandidate {
  conversationId: string;
  candidate: any; // RTCIceCandidate (browser type)
}

export const setupWebRTCHandlers = (io: SocketServer, socket: Socket, userId: string) => {
  
  // ============================================================================
  // WEBRTC OFFER - When user initiates video call
  // ============================================================================
  socket.on('webrtc:offer', async ({ conversationId, offer }: WebRTCOffer) => {
    try {
      console.log(`📹 WebRTC offer from ${userId} for conversation ${conversationId}`);

      // Get conversation participants
      const rooms = Array.from(socket.rooms);
      const conversationRoom = rooms.find(room => room === conversationId);

      if (!conversationRoom) {
        console.error('❌ User not in conversation room');
        return;
      }

      // Send offer to the other participant in the conversation
      socket.to(conversationId).emit('webrtc:offer', {
        userId,
        offer,
        conversationId
      });

      console.log(`✅ WebRTC offer sent to conversation ${conversationId}`);
    } catch (error) {
      console.error('WebRTC offer error:', error);
      socket.emit('webrtc:error', { message: 'Failed to send offer' });
    }
  });

  // ============================================================================
  // WEBRTC ANSWER - When user responds to video call
  // ============================================================================
  socket.on('webrtc:answer', async ({ conversationId, answer }: WebRTCAnswer) => {
    try {
      console.log(`📹 WebRTC answer from ${userId} for conversation ${conversationId}`);

      // Send answer back to the caller
      socket.to(conversationId).emit('webrtc:answer', {
        userId,
        answer,
        conversationId
      });

      console.log(`✅ WebRTC answer sent to conversation ${conversationId}`);
    } catch (error) {
      console.error('WebRTC answer error:', error);
      socket.emit('webrtc:error', { message: 'Failed to send answer' });
    }
  });

  // ============================================================================
  // ICE CANDIDATE - Exchange ICE candidates for NAT traversal
  // ============================================================================
  socket.on('webrtc:ice-candidate', async ({ conversationId, candidate }: ICECandidate) => {
    try {
      console.log(`🧊 ICE candidate from ${userId} for conversation ${conversationId}`);

      // Forward ICE candidate to the other peer
      socket.to(conversationId).emit('webrtc:ice-candidate', {
        userId,
        candidate,
        conversationId
      });
    } catch (error) {
      console.error('ICE candidate error:', error);
    }
  });

  // ============================================================================
  // CALL ENDED - When user ends video call
  // ============================================================================
  socket.on('webrtc:end-call', async ({ conversationId }: { conversationId: string }) => {
    try {
      console.log(`📞 User ${userId} ended call in conversation ${conversationId}`);

      // Notify the other peer
      socket.to(conversationId).emit('webrtc:call-ended', {
        userId,
        conversationId
      });

      console.log(`✅ Call end notification sent`);
    } catch (error) {
      console.error('End call error:', error);
    }
  });

  // ============================================================================
  // TOGGLE VIDEO/AUDIO - When user toggles their media
  // ============================================================================
  socket.on('webrtc:media-toggle', async ({ 
    conversationId, 
    type, 
    enabled 
  }: { 
    conversationId: string; 
    type: 'video' | 'audio'; 
    enabled: boolean;
  }) => {
    try {
      console.log(`🎥 User ${userId} toggled ${type} to ${enabled ? 'on' : 'off'}`);

      // Notify the other peer about media state change
      socket.to(conversationId).emit('webrtc:media-toggle', {
        userId,
        type,
        enabled
      });
    } catch (error) {
      console.error('Media toggle error:', error);
    }
  });
};