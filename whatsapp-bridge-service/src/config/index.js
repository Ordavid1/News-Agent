const config = {
  port: parseInt(process.env.PORT || '10000', 10),
  apiKey: process.env.API_KEY,
  authStorePath: process.env.AUTH_STORE_PATH || './auth_store',

  // SaaS app webhook integration
  saasWebhookUrl: process.env.SAAS_WEBHOOK_URL,
  saasWebhookSecret: process.env.SAAS_WEBHOOK_SECRET,

  // Rate limiting
  messagesPerMinute: parseInt(process.env.MESSAGES_PER_MINUTE || '15', 10),
  messagesPerHour: parseInt(process.env.MESSAGES_PER_HOUR || '100', 10),
  minMessageDelayMs: parseInt(process.env.MIN_MESSAGE_DELAY_MS || '1000', 10),
  maxMessageDelayMs: parseInt(process.env.MAX_MESSAGE_DELAY_MS || '3000', 10),

  // Circuit breaker
  maxReconnectRetries: parseInt(process.env.MAX_RECONNECT_RETRIES || '5', 10),
  circuitResetTimeoutMs: parseInt(process.env.CIRCUIT_RESET_TIMEOUT_MS || '300000', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info'
};

// Validate required config
if (!config.apiKey) {
  console.error('FATAL: API_KEY environment variable is required');
  process.exit(1);
}

export default config;
