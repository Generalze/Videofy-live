import { describe, expect, it } from 'vitest';
import {
  createListenerSocketOptions,
  joinCurrentListenerLanguage,
  resolveSocketTransportOptions,
} from './socketConfig';

describe('createListenerSocketOptions', () => {
  it('allows Socket.IO to start with polling and upgrade automatically', () => {
    const options = createListenerSocketOptions();

    expect(options.query).toEqual({ role: 'listener' });
    expect(options.transports).toBeUndefined();
    expect(options.reconnection).toBeUndefined();
  });

  it('supports a polling-only local development override', () => {
    expect(resolveSocketTransportOptions('polling')).toEqual({
      transports: ['polling'],
      upgrade: false,
    });
  });

  it('rejoins the currently selected language after reconnecting', () => {
    let targetLanguage = 'fr';
    const joins: string[] = [];
    const socket = {
      emit(_event: 'join:language', language: string) {
        joins.push(language);
      },
    };

    joinCurrentListenerLanguage(socket, () => targetLanguage);
    targetLanguage = 'es';
    joinCurrentListenerLanguage(socket, () => targetLanguage);

    expect(joins).toEqual(['fr', 'es']);
  });
});
