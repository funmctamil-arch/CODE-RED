import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  AudioPlayer,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../lib/logger";

const MUSIC_DIR = path.resolve(process.cwd(), "music");

export interface QueueEntry {
  filename: string;
  addedBy: string;
}

export class MusicPlayer {
  private player: AudioPlayer;
  private connection: VoiceConnection | null = null;
  private queue: QueueEntry[] = [];
  private currentIndex = 0;
  private isPlaying = false;

  constructor() {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.currentIndex++;
      this.playNext();
    });

    this.player.on("error", (err) => {
      logger.error({ err }, "Audio player error");
      this.currentIndex++;
      this.playNext();
    });
  }

  setConnection(conn: VoiceConnection) {
    this.connection = conn;
    conn.subscribe(this.player);
  }

  listSongs(): string[] {
    if (!fs.existsSync(MUSIC_DIR)) return [];
    return fs
      .readdirSync(MUSIC_DIR)
      .filter((f) => f.endsWith(".mp3") || f.endsWith(".ogg") || f.endsWith(".wav"))
      .sort();
  }

  findSong(name: string): string | null {
    const songs = this.listSongs();
    const lower = name.toLowerCase();
    const exact = songs.find((s) => s.toLowerCase() === lower + ".mp3" ||
      s.toLowerCase() === lower + ".ogg" ||
      s.toLowerCase() === lower + ".wav" ||
      s.toLowerCase() === lower);
    if (exact) return exact;
    const partial = songs.find((s) => s.toLowerCase().includes(lower));
    return partial ?? null;
  }

  addToQueue(filename: string, addedBy: string): void {
    this.queue.push({ filename, addedBy });
    if (!this.isPlaying) {
      this.currentIndex = this.queue.length - 1;
      this.playNext();
    }
  }

  playNext(): void {
    if (!this.connection) return;
    if (this.currentIndex >= this.queue.length) {
      this.isPlaying = false;
      // Loop back to start if queue has items
      if (this.queue.length > 0) {
        this.currentIndex = 0;
        this.playNext();
      }
      return;
    }
    const entry = this.queue[this.currentIndex];
    const filePath = path.join(MUSIC_DIR, entry.filename);
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, "Song file not found, skipping");
      this.currentIndex++;
      this.playNext();
      return;
    }
    const resource = createAudioResource(filePath);
    this.player.play(resource);
    this.isPlaying = true;
    logger.info({ song: entry.filename }, "Now playing");
  }

  skip(): string | null {
    const current = this.queue[this.currentIndex]?.filename ?? null;
    this.currentIndex++;
    if (this.currentIndex >= this.queue.length) this.currentIndex = 0;
    this.playNext();
    return current;
  }

  pause(): boolean {
    return this.player.pause();
  }

  resume(): boolean {
    return this.player.unpause();
  }

  stop(): void {
    this.queue = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.player.stop();
  }

  getQueue(): QueueEntry[] {
    return this.queue;
  }

  getCurrentSong(): string | null {
    return this.queue[this.currentIndex]?.filename ?? null;
  }

  getStatus(): AudioPlayerStatus {
    return this.player.state.status;
  }

  isConnected(): boolean {
    return this.connection !== null;
  }
}
