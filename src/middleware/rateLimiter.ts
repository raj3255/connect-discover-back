import rateLimit from 'express-rate-limit';

export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for authentication endpoints (login, register,
// forgot/reset password, resend verification) to slow down brute-force and
// abuse. Successful requests still count, which is acceptable for these
// low-frequency, sensitive actions.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});
