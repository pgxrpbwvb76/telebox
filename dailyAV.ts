/**
 * dailyAV.ts — TeleBox 每日随机影片推送插件
 *
 * 每天早上（管理员可配时间），从指定 Emby 媒体库随机抽取一部影片，
 * 将其标题、简介、海报、年份、类型、播放直链推送到指定群。
 *
 * 直链直接取自 PlaybackInfo 的 MediaSources[0].Path（不做任何回退）。
 *
 * 命令：.dailyAV（详见帮助）
 */

import { Plugin } from "@utils/pluginBase";
import type { TelegramClient } from "teleproto";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { htmlEscape } from "@utils/htmlEscape";
import { SudoDB } from "@utils/sudoDB";
import { JSONFilePreset } from "lowdb/node";
import axios, { AxiosInstance } from "axios";
import * as https from "https";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

// ────────────────────────────────────────────────────────────
// 常量与工具
// ────────────────────────────────────────────────────────────

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] ?? ".";

const PLUGIN_NAME = "dailyav";
const MAX_MESSAGE_LENGTH = 4096;
const HTTP_TIMEOUT_MS = 20000;

interface AvConfig {
  /** Emby 服务器地址（公网，拼直链/海报用） */
  base: string;
  /** Emby API Key */
  apiKey: string;
  /** 目标媒体库名称（VirtualFolders 的 Name，精确匹配） */
  library: string;
  /** 推送的目标群（Telegram 会话/群 ID，字符串） */
  chatId: string;
  /** 每天推送时间，格式 HH:MM */
  time: string;
  /** 是否开启每日推送 */
  enabled: boolean;
  /** 管理员 TG ID 列表（写操作） */
  admins: number[];
  /** 历史推送记录：itemId -> 最近一次推送日期 YYYY-MM-DD */
  history: Record<string, string>;
}

const DEFAULT_CONFIG: AvConfig = {
  base: "",
  apiKey: "",
  library: "",
  chatId: "",
  time: "08:00",
  enabled: false,
  admins: [],
  history: {},
};

function htmlEscapeSafe(t: unknown): string {
  return htmlEscape(t);
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 清理刮削简介中的 HTML、脚本残留、空白和已知营销尾文；不执行任何代码。 */
function cleanOverview(input: unknown): string {
  let text = String(input ?? "");
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  text = text.replace(/^.*\b(?:window|document)\s*(?:\[|\.).*$/gm, "");
  text = text.replace(/<(?:br\s*\/?|\/p|\/div)>/gi, "\n").replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"');
  // 仅截掉明确的订阅广告尾段，不按普通剧情词汇删内容。
  const promo = text.search(/当アカウントをフォロー|メルマガをお受け取り|こちらよりフォロー/);
  if (promo >= 0) text = text.slice(0, promo);
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowHM(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describeError(error: unknown): string {
  const err = error as any;
  if (!err) return "未知错误";
  const code = err.code || err.cause?.code;
  if (code === "ECONNREFUSED") return "连接被拒绝（服务未启动或端口错误）";
  if (code === "ENOTFOUND") return "域名解析失败";
  if (code === "ETIMEDOUT" || code === "ECONNABORTED") return "连接超时";
  return err.message || String(err);
}

function splitMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > maxLength) {
      if (cur) parts.push(cur);
      cur = line;
    } else {
      cur += (cur ? "\n" : "") + line;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

async function show(msg: Api.Message, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const payload: any = { parseMode: "html" };
    if (i === 0) {
      payload.text = chunks[i];
      try {
        await msg.edit(payload);
        continue;
      } catch {
        /* fallthrough to reply */
      }
    }
    try {
      await msg.reply({ message: chunks[i], parseMode: "html" } as any);
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 发送失败:`, error);
    }
  }
}

// ────────────────────────────────────────────────────────────
// Emby 客户端（精简版，仅每日推送所需）
// ────────────────────────────────────────────────────────────

class AvEmbyApi {
  readonly origin: string;
  private readonly base: string;
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.origin = String(baseUrl || "").trim().replace(/\/+$/, "");
    this.base = /\/emby$/i.test(this.origin) ? this.origin : `${this.origin}/emby`;
    this.http = axios.create({
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 3,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: {
        "X-Emby-Token": apiKey,
        "X-Emby-Authorization":
          'MediaBrowser Client="TeleBox", Device="TeleBox-DailyAV", DeviceId="telebox-dailyav", Version="1.0.0"',
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  }

  private async req<T = any>(
    method: "GET" | "POST",
    url: string,
    data?: unknown,
    params?: Record<string, unknown>,
  ): Promise<T> {
    let res;
    try {
      res = await this.http.request<T>({ method, url: `${this.base}${url}`, data, params });
    } catch (error) {
      throw new Error(describeError(error));
    }
    if (res.status >= 400) {
      let detail = "";
      const body: any = res.data;
      if (body && typeof body === "object") detail = body.Message || body.error || "";
      else if (typeof body === "string") detail = body.slice(0, 200);
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return res.data as T;
  }

  /** 列出媒体库 */
  virtualFolders() {
    return this.req<any[]>("GET", "/Library/VirtualFolders");
  }

  /** 拉取指定媒体库下所有影片条目（递归） */
  async itemsInLibrary(parentId: string): Promise<any[]> {
    const out: any[] = [];
    let startIndex = 0;
    const limit = 200;
    while (true) {
      const res = await this.req<any>("GET", "/Items", undefined, {
        ParentId: parentId,
        Recursive: true,
        IncludeItemTypes: "Movie,Episode,Video",
        Fields: "Genres,ProductionYear,Overview,Path",
        SortBy: "Random",
        SortOrder: "Ascending",
        StartIndex: startIndex,
        Limit: limit,
      });
      const items: any[] = res?.Items || [];
      out.push(...items);
      if (items.length < limit) break;
      startIndex += limit;
      if (out.length > 5000) break;
    }
    return out;
  }

  /** 查播放直链（取 MediaSources[0].Path） */
  async playbackInfo(itemId: string): Promise<any> {
    // 只查询媒体源，不请求协商播放/转码，避免不完整 DeviceProfile 引发服务端异常。
    return this.req<any>("POST", `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {});
  }

  /** 海报图片 URL */
  imageUrl(itemId: string): string {
    return `${this.base}/Items/${itemId}/Images/Primary?maxHeight=720&maxWidth=1280&quality=90`;
  }
}

// ────────────────────────────────────────────────────────────
// 插件
// ────────────────────────────────────────────────────────────

class DailyAVPlugin extends Plugin {
  name = PLUGIN_NAME;

  private readonly HELP = `📅 <b>每日随机影片推送</b>

<b>📝 功能:</b>
• 每天早上自动从指定媒体库随机抽一部影片推送到指定群
• 内容含标题、简介、海报、年份、类型、播放直链

<b>🔧 配置:</b>
• <code>${mainPrefix}dailyAV</code> 查看配置
• <code>${mainPrefix}dailyAV set base &lt;Emby公网地址&gt;</code>
• <code>${mainPrefix}dailyAV set key &lt;APIKey&gt;</code>
• <code>${mainPrefix}dailyAV set lib &lt;媒体库名&gt;</code>
• <code>${mainPrefix}dailyAV set chat &lt;群ID&gt;</code>
• <code>${mainPrefix}dailyAV set time &lt;HH:MM&gt;</code>
• <code>${mainPrefix}dailyAV on / off</code> 开关
• <code>${mainPrefix}dailyAV libs</code> 列媒体库
• <code>${mainPrefix}dailyAV test</code> 立即推一条测试
• <code>${mainPrefix}dailyAV next</code> 随机抽一部（只发给自己预览）

<b>💡 示例:</b>
• <code>${mainPrefix}dailyAV set base https://emby.xxx.com</code>
• <code>${mainPrefix}dailyAV set lib 国漫</code>
• <code>${mainPrefix}dailyAV set time 08:30</code>
• <code>${mainPrefix}dailyAV on</code>`;

  description = "📅 每日随机推送指定媒体库的一部影片到群";

  private db: any = null;
  private sudoDB: SudoDB | null = null;

  private async getDB(): Promise<any> {
    if (this.db) return this.db;
    const dir = createDirectoryInAssets(PLUGIN_NAME);
    this.db = await JSONFilePreset<AvConfig>(path.join(dir, "config.json"), { ...DEFAULT_CONFIG });
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
      if ((this.db.data as any)[k] === undefined) {
        (this.db.data as any)[k] = Array.isArray(v) ? [] : v;
      }
    }
    await this.db.write();
    return this.db;
  }

  private async cfg(): Promise<AvConfig> {
    const db = await this.getDB();
    return db.data as AvConfig;
  }

  private async save(): Promise<void> {
    const db = await this.getDB();
    await db.write();
  }

  private sudo(): SudoDB {
    if (!this.sudoDB) this.sudoDB = new SudoDB();
    return this.sudoDB;
  }

  private isSudo(uid: number): boolean {
    try {
      return this.sudo().has(uid);
    } catch {
      return false;
    }
  }

  private toId(v: unknown): number | null {
    if (v === undefined || v === null || typeof v === "boolean") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** 真实发送者（入站消息 fromId/senderId） */
  private realSenderId(msg: Api.Message): number | null {
    const m = msg as any;
    const tryIds: unknown[] = [m.senderId, m.fromId?.userId];
    try {
      tryIds.push(m.sender?.id);
    } catch {
      /* ignore */
    }
    for (const v of tryIds) {
      const id = this.toId(v);
      if (id) return id;
    }
    if (!m.out) {
      const cid = this.toId(m.chatId);
      if (cid) return cid;
    }
    return null;
  }

  private async requireAdmin(msg: Api.Message): Promise<boolean> {
    const uid = this.realSenderId(msg);
    const cfg = await this.cfg();
    if (uid) {
      if (this.isSudo(uid) || cfg.admins.includes(uid)) return true;
      // 引导：admin 列表为空时，第一个写操作者成为管理员
      if (cfg.admins.length === 0 && this.sudoCount() === 0) {
        const sender: any = (msg as any).sender;
        this.sudo().add(uid, sender?.username || sender?.firstName || String(uid));
        cfg.admins.push(uid);
        await this.save();
        await show(msg, `🛡️ <b>已识别为管理员</b>\n已将 <code>${uid}</code> 登记为管理员。`);
        return true;
      }
    }
    await show(msg, "🚫 <b>权限不足</b>\n仅管理员可操作（用 TeleBox 的 <code>.sudo add &lt;uid&gt;</code> 授权）。");
    return false;
  }

  private sudoCount(): number {
    try {
      return this.sudo().ls().length;
    } catch {
      return 0;
    }
  }

  // ── 命令入口 ────────────────────────────────────────────

  cmdHandlers = {
    dailyAV: async (msg: Api.Message) => this.handle(msg),
    dailyav: async (msg: Api.Message) => this.handle(msg),
    dav: async (msg: Api.Message) => this.handle(msg),
  };

  private async handle(msg: Api.Message): Promise<void> {
    try {
      const args = (msg.text || "").trim().split(/\s+/).slice(1);
      const sub = (args[0] || "").toLowerCase();
      const rest = args.slice(1);

      // 只读：查看配置 / 列库
      if (["", "help", "h", "?"].includes(sub)) {
        await this.cmdHelp(msg);
        return;
      }
      if (["libs", "libraries"].includes(sub)) {
        await this.cmdLibs(msg);
        return;
      }
      // next 只预览给自己，不做写操作；但需已配置
      if (["next", "preview"].includes(sub)) {
        if (!(await this.requireAdmin(msg))) return;
        await this.cmdNext(msg);
        return;
      }

      // 写操作，需管理员
      if (!(await this.requireAdmin(msg))) return;

      switch (sub) {
        case "set":
          await this.cmdSet(msg, rest);
          return;
        case "on":
        case "enable":
          await this.setFlag(msg, true);
          return;
        case "off":
        case "disable":
          await this.setFlag(msg, false);
          return;
        case "test":
          await this.cmdTest(msg);
          return;
        default:
          await show(
            msg,
            `❓ 未知子命令 <code>${htmlEscapeSafe(sub)}</code>\n💡 <code>${mainPrefix}dailyAV</code> 查看帮助`,
          );
      }
    } catch (error) {
      await show(msg, `❌ <b>操作失败</b>\n<code>${htmlEscapeSafe(describeError(error))}</code>`);
    }
  }

  private async cmdHelp(msg: Api.Message): Promise<void> {
    const cfg = await this.cfg();
    const lines = [
      this.HELP,
      ``,
      `<b>当前配置</b>`,
      `• base: <code>${htmlEscapeSafe(cfg.base || "未设置")}</code>`,
      `• 媒体库: <code>${htmlEscapeSafe(cfg.library || "未设置")}</code>`,
      `• 目标群: <code>${htmlEscapeSafe(cfg.chatId || "未设置")}</code>`,
      `• 时间: <code>${htmlEscapeSafe(cfg.time)}</code>`,
      `• 状态: ${cfg.enabled ? "✅ 开启" : "⏸ 关闭"}`,
    ];
    await show(msg, lines.join("\n"));
  }

  private async cmdLibs(msg: Api.Message): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg.base || !cfg.apiKey) {
      await show(msg, "❌ 请先 <code>set base</code> 和 <code>set key</code>");
      return;
    }
    const api = new AvEmbyApi(cfg.base, cfg.apiKey);
    const folders = await api.virtualFolders();
    if (!folders?.length) {
      await show(msg, "📭 没有媒体库");
      return;
    }
    const lines = [`🗂️ <b>媒体库列表</b>`, ``];
    folders.forEach((f: any) => {
      lines.push(
        `• <b>${htmlEscapeSafe(f.Name)}</b> <i>(${htmlEscapeSafe(f.CollectionType || "mixed")})</i> — <code>${htmlEscapeSafe(f.ItemId || "")}</code>`,
      );
    });
    await show(msg, lines.join("\n"));
  }

  private async cmdSet(msg: Api.Message, rest: string[]): Promise<void> {
    const cfg = await this.cfg();
    const key = (rest[0] || "").toLowerCase();
    const value = rest.slice(1).join(" ").trim();

    const valid = ["base", "key", "apikey", "lib", "library", "chat", "time"];
    if (!valid.includes(key) || !value) {
      await show(
        msg,
        `❌ 用法: <code>${mainPrefix}dailyAV set base|key|lib|chat|time &lt;值&gt;</code>`,
      );
      return;
    }

    switch (key) {
      case "base":
        if (!/^https?:\/\//i.test(value)) {
          await show(msg, "❌ base 需以 http:// 或 https:// 开头");
          return;
        }
        cfg.base = value.replace(/\/+$/, "");
        break;
      case "key":
      case "apikey":
        cfg.apiKey = value.trim();
        break;
      case "lib":
      case "library":
        cfg.library = value;
        break;
      case "chat":
        cfg.chatId = value.replace(/[^\d-]/g, "").replace(/^-/, "-");
        break;
      case "time":
        if (!/^\d{1,2}:\d{2}$/.test(value)) {
          await show(msg, "❌ 时间格式应为 HH:MM，如 08:30");
          return;
        }
        const [h, m] = value.split(":").map(Number);
        if (h < 0 || h > 23 || m < 0 || m > 59) {
          await show(msg, "❌ 时间超出范围");
          return;
        }
        cfg.time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        break;
    }
    await this.save();
    const displayKey: Record<string, string> = {
      base: cfg.base,
      key: cfg.apiKey,
      apikey: cfg.apiKey,
      lib: cfg.library,
      library: cfg.library,
      chat: cfg.chatId,
      time: cfg.time,
    };
    const displayVal =
      key === "key" || key === "apikey"
        ? cfg.apiKey
          ? `${cfg.apiKey.slice(0, 6)}***`
          : ""
        : displayKey[key] || "";
    await show(msg, `✅ 已设置 <code>${htmlEscapeSafe(key)}</code> = <code>${htmlEscapeSafe(displayVal)}</code>`);
  }

  private async setFlag(msg: Api.Message, on: boolean): Promise<void> {
    const cfg = await this.cfg();
    cfg.enabled = on;
    await this.save();
    await show(msg, on ? "✅ 每日推送已开启" : "⏸ 每日推送已关闭");
  }

  // ── 核心：随机选一部 + 生成推送内容 ──────────────────────

  private async resolveLibraryId(api: AvEmbyApi, libraryName: string): Promise<string> {
    const folders = await api.virtualFolders();
    const f = folders.find(
      (x: any) => String(x.Name).trim().toLowerCase() === libraryName.trim().toLowerCase(),
    );
    if (!f) {
      throw new Error(`未找到媒体库「${libraryName}」\n可用: ${folders.map((x: any) => x.Name).join("、")}`);
    }
    return String(f.ItemId);
  }

  private async pickOne(api: AvEmbyApi, libraryName: string): Promise<any> {
    const libId = await this.resolveLibraryId(api, libraryName);
    const items = await api.itemsInLibrary(libId);
    if (items.length === 0) throw new Error("媒体库为空");
    const idx = Math.floor(Math.random() * items.length);
    return items[idx];
  }

  private itemMeta(item: any): { title: string; year: string; genres: string; overview: string } {
    const year = item.ProductionYear ? String(item.ProductionYear) : "";
    const genres = Array.isArray(item.Genres) ? truncate(item.Genres.slice(0, 6).join(" / "), 90) : "";
    let title = item.Name || "未知";
    // 剧集：带 SxxExx
    if (item.Type === "Episode" && item.SeriesName) {
      const s = item.ParentIndexNumber != null ? `S${String(item.ParentIndexNumber).padStart(2, "0")}` : "";
      const e = item.IndexNumber != null ? `E${String(item.IndexNumber).padStart(2, "0")}` : "";
      title = `${item.SeriesName} ${s}${e} — ${item.Name}`;
    }
    title = truncate(String(title), 120);
    const overview = truncate(cleanOverview(item.Overview), 350);
    return { title, year, genres, overview };
  }

  /** 生成要推送的 HTML 文本 + 图片 URL + 直链 */
  private async buildPush(api: AvEmbyApi, item: any): Promise<{ text: string; imageUrl: string }> {
    const { title, year, genres, overview } = this.itemMeta(item);
    const itemId = String(item.Id);

    // 只取当前服务器 PlaybackInfo 返回的 Path，不使用 DirectStreamUrl、不拼接路径。
    let info: any;
    try {
      info = await api.playbackInfo(itemId);
    } catch (error) {
      throw new Error(`条目 ${itemId} (${item.Type || "未知类型"}) PlaybackInfo 失败: ${describeError(error)}`);
    }
    const directUrl = info?.MediaSources?.[0]?.Path;
    if (typeof directUrl !== "string" || !/^https?:\/\//i.test(directUrl)) {
      throw new Error(`条目 ${itemId} 没有可用的 HTTP(S) Path，已取消推送（不回退）`);
    }

    const typeLabel = item.Type || "";
    const lines: string[] = [];
    lines.push(`🎬 <b>${htmlEscapeSafe(title)}</b>`);
    if (year) lines.push(`📅 ${htmlEscapeSafe(year)}`);
    if (genres) lines.push(`🏷️ ${htmlEscapeSafe(genres)}`);
    if (overview) {
      lines.push(``);
      lines.push(`📝 ${htmlEscapeSafe(overview)}`);
    }
    lines.push(``, `🔗 <a href="${htmlEscapeSafe(directUrl)}">播放直链</a>`);
    if (typeLabel) lines.push(``, `📦 类型: ${htmlEscapeSafe(typeLabel)}`);

    return { text: lines.join("\n"), imageUrl: api.imageUrl(itemId) };
  }

  /** 推送一条到指定聊天 */
  private async doPush(api: AvEmbyApi, item: any, chatId: string): Promise<void> {
    const client: any = await getGlobalClient();
    if (!client) throw new Error("获取 Telegram 客户端失败");
    const { text, imageUrl } = await this.buildPush(api, item);

    // Emby 图片 URL 无扩展名，teleproto 会误判成 document。
    // 下载并校验图片魔数，再以 .jpg/.png 临时文件上传成照片。
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dailyav-poster-"));
    try {
      const cfg = await this.cfg();
      const response = await axios.create().request<any>({
        method: "GET", url: imageUrl, responseType: "arraybuffer",
        timeout: HTTP_TIMEOUT_MS, maxRedirects: 0,
        headers: { "X-Emby-Token": cfg.apiKey },
        maxContentLength: 10 * 1024 * 1024,
        validateStatus: (status: number) => status === 200,
      });
      const data = Buffer.from(response.data);
      const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
      const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      if (!jpeg && !png) throw new Error("海报接口未返回 JPEG/PNG 图片");
      const poster = path.join(tempDir, jpeg ? "poster.jpg" : "poster.png");
      await fs.writeFile(poster, data);
      await client.sendFile(chatId, {
        file: poster,
        forceDocument: false,
        caption: text,
        parseMode: "html",
      } as any);
      return;
    } catch (error) {
      // 不打印 Axios 错误对象，避免其请求头泄露 API Key。
      console.error(`[${PLUGIN_NAME}] 海报发送失败，回退纯文本: ${describeError(error)}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    for (const chunk of splitMessage(text)) {
      await client.sendMessage(chatId, { message: chunk, parseMode: "html" } as any);
    }
  }

  /** 记录历史：itemId 尽量全局去重（当天不重复） */
  private async markPushed(itemId: string): Promise<void> {
    const cfg = await this.cfg();
    cfg.history[itemId] = todayStr();
    // 只保留最近 90 天记录，防止无限膨胀
    const cutoff = new Date(Date.now() - 90 * 86400000);
    for (const [id, date] of Object.entries(cfg.history)) {
      if (new Date(date) < cutoff) delete cfg.history[id];
    }
    await this.save();
  }

  private async cmdTest(msg: Api.Message): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg.base || !cfg.apiKey || !cfg.library || !cfg.chatId) {
      await show(msg, "❌ 请先完整配置 base / key / lib / chat");
      return;
    }
    await show(msg, "⏳ 正在随机选取并推送…");
    const api = new AvEmbyApi(cfg.base, cfg.apiKey);
    const item = await this.pickOne(api, cfg.library);
    await this.doPush(api, item, cfg.chatId);
    await show(msg, `✅ 已推送到 <code>${htmlEscapeSafe(cfg.chatId)}</code>：<b>${htmlEscapeSafe(item.Name || "")}</b>`);
  }

  private async cmdNext(msg: Api.Message): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg.base || !cfg.apiKey || !cfg.library) {
      await show(msg, "❌ 请先配置 base / key / lib");
      return;
    }
    await show(msg, "⏳ 正在随机抽取…");
    const api = new AvEmbyApi(cfg.base, cfg.apiKey);
    const item = await this.pickOne(api, cfg.library);
    const { text } = await this.buildPush(api, item);
    await show(msg, `🎲 <b>随机结果预览</b>\n\n${text}`);
  }

  // ── 定时任务 ────────────────────────────────────────────

  cronTasks = {
    dailyAV: {
      cron: "* * * * *",
      description: "每日定时推送（按配置时间 + 当天去重）",
      handler: async (client: TelegramClient) => {
        const cfg = await this.cfg();
        if (!cfg.enabled) return;
        if (!cfg.base || !cfg.apiKey || !cfg.library || !cfg.chatId) return;
        if (nowHM() !== cfg.time) return;

        const today = todayStr();
        const api = new AvEmbyApi(cfg.base, cfg.apiKey);
        try {
          const item = await this.pickOne(api, cfg.library);
          const itemId = String(item.Id);
          // 当天已推过该条目则跳过（防止多实例/重复触发）
          if (cfg.history[itemId] === today) return;
          await this.doPush(api, item, cfg.chatId);
          await this.markPushed(itemId);
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] 定时推送失败:`, error);
          // 推失败也试图通知，但不刷屏（仅打印日志）
        }
      },
    },
  };

  // ── 清理 ────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    try {
      this.sudoDB?.close();
    } catch {
      /* ignore */
    }
    this.sudoDB = null;
    this.db = null;
  }
}

export default new DailyAVPlugin();
