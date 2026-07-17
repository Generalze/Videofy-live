import { loadRootEnv, readCsv, readPort } from './env.js';

export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
}

export function loadConfig(): GatewayConfig {
  loadRootEnv();

  return {
    port: readPort('GATEWAY_PORT', 3001),
    host: process.env['GATEWAY_HOST'] ?? 'localhost',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    corsOrigins: readCsv('CORS_ORIGINS', 'http://localhost:5173,http://localhost:5174'),
  };
}
