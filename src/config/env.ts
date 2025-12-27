import dotenv from 'dotenv';
dotenv.config();
export const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000'),
  API_URL: process.env.API_URL || 'http://localhost:5000',
  
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: parseInt(process.env.DB_PORT || '5432'),
  DB_NAME: process.env.DB_NAME || 'connect_discover',
  DB_USER: process.env.DB_USER || 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),
  
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'your-refresh-key',
  JWT_EXPIRY: process.env.JWT_EXPIRY || '15m',
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || '7d',
  
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL || 'noreply@connectdiscover.com',
  
  NOMINATIM_API_URL: process.env.NOMINATIM_API_URL || 'https://nominatim.openstreetmap.org',
  
  //CORS_ORIGIN: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  CORS_ORIGIN: [
    "http://localhost:5173",
    "http://localhost:5500",
    "http://localhost:8080",
    "http://127.0.0.1:5500"
  ],
  
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760'),
};