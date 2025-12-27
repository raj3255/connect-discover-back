export interface User {
  id: string;
  email: string;
  name: string;
  age: number;
  gender: 'male' | 'female' | 'other';
  bio?: string;
  avatar_url?: string;
  interests?: string;
  is_verified: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  text?: string;
  media_urls?: string[];
  message_type: 'text' | 'image' | 'video';
  is_read: boolean;
  read_at?: Date;
  created_at: Date;
}

export interface Conversation {
  id: string;
  user_1_id: string;
  user_2_id: string;
  chat_mode: 'local' | 'global';
  started_at: Date;
  ended_at?: Date;
  last_message_at: Date;
  is_active: boolean;
}

export interface Album {
  id: string;
  user_id: string;
  photo_url: string;
  thumbnail_url?: string;
  caption?: string;
  is_public: boolean;
  is_expiring: boolean;
  expiration_type: 'never' | 'once' | '24hrs' | '7days';
  shared_with?: { userId: string; sharedAt: Date; accessType: string }[];
  created_at: Date;
}

export interface JWTPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

export interface SocketUser {
  userId: string;
  socketId: string;
  onlineStatus: 'online' | 'idle' | 'offline';
  lastActivity: Date;
}