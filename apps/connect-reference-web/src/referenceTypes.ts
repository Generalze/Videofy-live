// owner: masterzee001
/**
 * Connect Reference product types — the vocabulary the BROWSER speaks.
 *
 * Everything here mirrors the Connect Reference server's product API: room ids
 * (`room_`), join tokens, display names, languages. Connect's public ids and
 * the project key never appear in this file or anywhere else in this app;
 * the server keeps both on its side of the fence.
 */

export type RoomMode = 'normal' | 'translated';

export interface RoomSummary {
  roomId: string;
  name: string;
  mode: RoomMode;
  scheduledFor?: string;
  createdAt: string;
  ended: boolean;
  live: boolean;
  participantCount: number;
}

/** A participant as the KC server reports it: product fields only. */
export interface RoomParticipantInfo {
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  connected: boolean;
}

export interface RoomDetail {
  roomId: string;
  name: string;
  mode: RoomMode;
  scheduledFor?: string;
  createdAt: string;
  ended: boolean;
  live?: boolean;
  participantCount?: number;
  /** KC-layer policy; absent is read as the server default (allowed). */
  transcriptDownloadAllowed?: boolean;
  participants?: RoomParticipantInfo[];
}

export interface RefConfig {
  languages: string[];
  limits?: {
    conferenceParticipants?: number;
  };
}

export interface CreateRoomInput {
  name: string;
  mode: RoomMode;
  scheduledFor?: string;
}

export interface CreatedRoom {
  room: RoomDetail;
  /** Shown exactly once; this browser also retains it in localStorage. */
  hostKey: string;
}

export interface JoinTokenRequest {
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  subject: string;
}
