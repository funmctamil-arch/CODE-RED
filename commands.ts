import {
  Message,
  TextChannel,
  GuildMember,
  Attachment,
} from "discord.js";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { MusicPlayer } from "./player";
import { logger } from "../lib/logger";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "!";
const MUSIC_DIR = path.resolve(process.cwd(), "music");
const player = new MusicPlayer();

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  // Handle MP3/audio file attachments — save to music folder
  if (message.attachments.size > 0) {
    await handleAttachments(message);
    return;
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  switch (command) {
    case "join":
      await cmdJoin(message);
      break;
    case "play":
      await cmdPlay(message, args.join(" "));
      break;
    case "skip":
      await cmdSkip(message);
      break;
    case "pause":
      await cmdPause(message);
      break;
    case "resume":
      await cmdResume(message);
      break;
    case "stop":
      await cmdStop(message);
      break;
    case "queue":
    case "q":
      await cmdQueue(message);
      break;
    case "list":
    case "songs":
      await cmdList(message);
      break;
    case "np":
    case "nowplaying":
      await cmdNowPlaying(message);
      break;
    case "help":
      await cmdHelp(message);
      break;
  }
}

async function handleAttachments(message: Message): Promise<void> {
  const audioExts = [".mp3", ".ogg", ".wav", ".flac", ".m4a"];
  const audioAttachments = message.attachments.filter((a: Attachment) => {
    const ext = path.extname(a.name ?? "").toLowerCase();
    return audioExts.includes(ext);
  });

  if (audioAttachments.size === 0) return;

  if (!fs.existsSync(MUSIC_DIR)) {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
  }

  const saved: string[] = [];
  const failed: string[] = [];

  await message.reply(`⏬ Downloading ${audioAttachments.size} file(s)...`);

  for (const [, attachment] of audioAttachments) {
    const filename = attachment.name ?? "unknown.mp3";
    const destPath = path.join(MUSIC_DIR, filename);

    try {
      await downloadFile(attachment.url, destPath);
      saved.push(filename);
      logger.info({ filename }, "Saved song from Discord attachment");
    } catch (err) {
      logger.error({ err, filename }, "Failed to download attachment");
      failed.push(filename);
    }
  }

  let reply = "";
  if (saved.length > 0) {
    reply += `✅ Saved ${saved.length} song(s):\n${saved.map((s) => `• **${s}**`).join("\n")}`;
    reply += `\n\nPlay panna: \`!play ${path.basename(saved[0]!, path.extname(saved[0]!))}\``;
  }
  if (failed.length > 0) {
    reply += `\n❌ Failed: ${failed.join(", ")}`;
  }

  await message.reply(reply);
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith("https") ? https.get : http.get;

    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location ?? url, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    }).on("error", (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function getVoiceChannel(message: Message) {
  const member = message.member as GuildMember;
  const vc = member?.voice?.channel;
  if (!vc) {
    await message.reply("❌ Nee oru voice channel-la iru da first!");
    return null;
  }
  return vc;
}

async function ensureConnected(message: Message): Promise<boolean> {
  if (player.isConnected()) return true;
  const vc = await getVoiceChannel(message);
  if (!vc) return false;

  const conn = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    player.setConnection(conn);

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        conn.destroy();
      }
    });

    logger.info({ channel: vc.name }, "Joined voice channel");
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to join voice channel");
    await message.reply("❌ Voice channel-la join panna mudiyala!");
    return false;
  }
}

async function cmdJoin(message: Message) {
  const vc = await getVoiceChannel(message);
  if (!vc) return;
  const conn = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
  });
  await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
  player.setConnection(conn);
  await message.reply(`✅ **${vc.name}** channel-la join panniten! Ready to play 🎵`);
}

async function cmdPlay(message: Message, songName: string) {
  if (!songName) {
    await message.reply("❌ Song name kodu da! Example: `!play despacito`");
    return;
  }

  const connected = await ensureConnected(message);
  if (!connected) return;

  const filename = player.findSong(songName);
  if (!filename) {
    const songs = player.listSongs();
    if (songs.length === 0) {
      await message.reply("❌ Music folder-la songs illai! Inga MP3 file attach panna — bot save paadum 🎵");
    } else {
      await message.reply(`❌ **${songName}** kaanala! \`!list\` potu available songs paaru.`);
    }
    return;
  }

  player.addToQueue(filename, message.author.username);
  const queue = player.getQueue();
  const pos = queue.length;
  if (pos > 1) {
    await message.reply(`✅ **${filename}** queue-la add aachi! (#${pos})`);
  } else {
    await message.reply(`🎵 Now playing: **${filename}**`);
  }
}

async function cmdSkip(message: Message) {
  const current = player.skip();
  if (current) {
    await message.reply(`⏭️ **${current}** skip panniten!`);
  } else {
    await message.reply("❌ Currently nothing playing!");
  }
}

async function cmdPause(message: Message) {
  const paused = player.pause();
  if (paused) {
    await message.reply("⏸️ Paused!");
  } else {
    await message.reply("❌ Pause panna mudiyala!");
  }
}

async function cmdResume(message: Message) {
  const resumed = player.resume();
  if (resumed) {
    await message.reply("▶️ Resumed!");
  } else {
    await message.reply("❌ Resume panna mudiyala!");
  }
}

async function cmdStop(message: Message) {
  player.stop();
  await message.reply("⏹️ Stopped! Queue clear aachi.");
}

async function cmdQueue(message: Message) {
  const queue = player.getQueue();
  if (queue.length === 0) {
    await message.reply("📭 Queue empty da!");
    return;
  }
  const current = player.getCurrentSong();
  const lines = queue.map((entry, i) => {
    const playing = entry.filename === current ? " ▶️" : "";
    return `${i + 1}. ${entry.filename}${playing} — added by ${entry.addedBy}`;
  });
  const text = lines.slice(0, 20).join("\n");
  await message.reply(`🎵 **Queue (${queue.length} songs):**\n\`\`\`\n${text}\n\`\`\``);
}

async function cmdList(message: Message) {
  const songs = player.listSongs();
  if (songs.length === 0) {
    await message.reply("❌ Music folder-la songs illai! Inga MP3 file attach panna — bot save paadum 🎵");
    return;
  }
  const text = songs.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const chunks = splitMessage(text, 1900);
  await message.reply(`🎵 **Available Songs (${songs.length}):**`);
  for (const chunk of chunks) {
    await (message.channel as TextChannel).send(`\`\`\`\n${chunk}\n\`\`\``);
  }
}

async function cmdNowPlaying(message: Message) {
  const song = player.getCurrentSong();
  if (!song) {
    await message.reply("❌ Currently nothing playing!");
  } else {
    await message.reply(`🎵 Now playing: **${song}**`);
  }
}

async function cmdHelp(message: Message) {
  const help = `
🤖 **Music Bot Commands**

🎵 \`!play <songname>\` — Song play pannu (partial name ok)
⏭️ \`!skip\` — Next song ku jump
⏸️ \`!pause\` — Pause
▶️ \`!resume\` — Resume
⏹️ \`!stop\` — Stop & queue clear
📋 \`!queue\` — Queue list paaru
📂 \`!list\` — All available songs
🎧 \`!np\` — Now playing
🔊 \`!join\` — Bot-ai VC-la join panna

**Songs add panna:**
MP3 file-ai itha channel-layee attach pannitu send pannu!
Bot automatically save panni ready paadum 🎵
  `.trim();
  await message.reply(help);
}

function splitMessage(text: string, maxLength: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
