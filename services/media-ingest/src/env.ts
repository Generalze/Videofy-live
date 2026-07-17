import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function readPort(name: string, fallback: number): number {
  return readInt(name, fallback, 1, 65_535);
}

export function readPositiveInt(name: string, fallback: number): number {
  return readInt(name, fallback, 1);
}

export function readCsv(name: string, fallback: string): string[] {
  const raw = process.env[name] ?? fallback;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must include at least one value`);
  }
  return values;
}

function readInt(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received "${raw}"`);
  }
  return value;
}
