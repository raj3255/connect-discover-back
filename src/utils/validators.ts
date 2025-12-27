import Joi from 'joi';

export const schemas = {
  register: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string()
      .min(8)
      .pattern(/[A-Z]/)
      .pattern(/[0-9]/)
      .pattern(/[@$!%*?&]/)
      .required(),
    name: Joi.string().min(2).max(50).required(),
    age: Joi.number().min(18).max(120).required(),
    gender: Joi.string().valid('male', 'female', 'other').required(),
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  updateProfile: Joi.object({
    name: Joi.string().min(2).max(50),
    bio: Joi.string().max(500),
    interests: Joi.string(),
    age: Joi.number().min(18).max(120),
    gender: Joi.string().valid('male', 'female', 'other'),
  }),

  searchCity: Joi.object({
    q: Joi.string().min(2).required(),
  }),

  sendMessage: Joi.object({
    conversation_id: Joi.string().uuid().required(),
    text: Joi.string(),
    media_urls: Joi.array().items(Joi.string()),
    message_type: Joi.string().valid('text', 'image', 'video'),
  }),
};

export function validate(schema: Joi.Schema, data: any) {
  return schema.validate(data, { abortEarly: false });
}