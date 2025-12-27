import * as redis from 'redis';
import { config } from './env.js';

const client = redis.createClient({
  socket: {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
  },
});

client.on('error', (err: any) => {
  console.error('Redis error:', err);
});

client.on('connect', () => {
  console.log('Connected to Redis');
});

export async function connectRedis() {
  await client.connect();
}

export async function setRedis(key: string, value: string, ttl?: number) {
  if (ttl) {
    await client.setEx(key, ttl, value);
  } else {
    await client.set(key, value);
  }
}

export async function getRedis(key: string) {
  return await client.get(key);
}

export async function deleteRedis(key: string) {
  await client.del(key);
}

export async function addToSet(key: string, member: string) {
  await client.sAdd(key, member);
}

export async function getSet(key: string) {
  return await client.sMembers(key);
}

export async function removeFromSet(key: string, member: string) {
  await client.sRem(key, member);
}

export async function closeRedis() {
  await client.quit();
}

export default client;