// src/types/customSocket.ts
import { Socket } from 'socket.io';

export interface CustomSocket extends Socket {
  userId: string;
}
