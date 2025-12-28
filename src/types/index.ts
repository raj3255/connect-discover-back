// src/types/index.ts

// ============================================================================
// JWT & AUTH TYPES
// ============================================================================

export interface JWTPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  age: number;
  gender: string;
  bio?: string;
  avatar_url?: string;
  is_verified: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSession {
  id: string;
  user_id: string;
  refresh_token: string;
  expires_at: string;
  created_at: string;
}

// ============================================================================
// CONVERSATION TYPES
// ============================================================================

export interface Conversation {
  id: string;
  user_1_id: string;
  user_2_id: string;
  chat_mode: string;
  is_active: boolean;
  started_at: string;
  last_message_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  text: string;
  is_read: boolean;
  read_at?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// ALBUM TYPES
// ============================================================================

export interface Album {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  photo_count?: number;
}

export interface AlbumPhoto {
  id: string;
  album_id: string;
  photo_url: string;
  uploaded_at: string;
}

// ============================================================================
// BLOCK & REPORT TYPES
// ============================================================================

export interface UserBlock {
  id: string;
  user_id: string;
  blocked_user_id: string;
  created_at: string;
}

export interface UserReport {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  description?: string;
  status: 'pending' | 'reviewed' | 'resolved' | 'dismissed';
  created_at: string;
  updated_at: string;
}

// ============================================================================
// LOCATION TYPES
// ============================================================================

export interface LocationHistory {
  id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  created_at: string;
}

// ============================================================================
// SOCKET TYPES
// ============================================================================

export interface SocketUser extends JWTPayload {
  socketId: string;
}

export interface ChatMessage {
  conversationId: string;
  senderId: string;
  text: string;
  timestamp: string;
}

export interface TypingIndicator {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface LocationUpdate {
  userId: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}

export interface StatusUpdate {
  userId: string;
  status: 'online' | 'offline' | 'away';
  timestamp: string;
}

export interface MatchEvent {
  userId: string;
  matchedUserId: string;
  conversationId: string;
  timestamp: string;
}

// ============================================================================
// REQUEST/RESPONSE TYPES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================================
// DATABASE QUERY RESULT
// ============================================================================

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
  command: string;
}