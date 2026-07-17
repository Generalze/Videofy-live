export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
}

export function loadConfig(): GatewayConfig {
  return {
    port: Number(process.env['GATEWAY_PORT'] ?? 3001),
    host: process.env['GATEWAY_HOST'] ?? 'localhost',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    corsOrigins: (process.env['CORS_ORIGINS'] ?? 'http://localhost:5173,http://localhost:5174').split(','),
  };
}
