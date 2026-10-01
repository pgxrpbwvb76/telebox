/**
 * emby.ts — TeleBox Emby 媒体服务器管理插件
 *
 * 功能：
 *   - 多 Emby 服务器配置（URL + API Key），可切换默认服务器
 *   - 用户管理：查看 / 启用 / 禁用 / 管理员权限 / 重置密码 / 新建 / 删除（二次确认）
 *   - 会话管理：在线播放列表、进度、停止播放、向播放端推送消息
 *   - 媒体库：统计、库列表、搜索条目、触发刷新
 *   - 活动日志、服务器信息、健康巡检（cron）
 *
 * 权限：
 *   - 读取类命令：TeleBox 管理员( sudo ) 或配置里的 readUsers；readAll=true 时对所有人开放
 *   - 写入类命令：仅 TeleBox 管理员
 *   - 引导：sudo 列表为空时，第一个执行写操作的人自动成为管理员
 *
 * 依赖：axios（TeleBox 内置）、lowdb/node（TeleBox 内置）
 */

import { Plugin } from "@utils/pluginBase";
import type { TelegramClient } from "teleproto";
import { Api } from "teleproto";
import { NewMessage, NewMessageEvent } from "teleproto/events";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { htmlEscape } from "@utils/htmlEscape";
import { SudoDB } from "@utils/sudoDB";
import { JSONFilePreset } from "lowdb/node";
import axios, { AxiosInstance } from "axios";
import * as https from "https";
import * as path from "path";

// ────────────────────────────────────────────────────────────
// 常量与通用工具
// ────────────────────────────────────────────────────────────

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] ?? ".";

const PLUGIN_NAME = "emby";
const MAX_MESSAGE_LENGTH = 4096;
const CONFIRM_TTL_MS = 3 * 60 * 1000;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_SEARCH_LIMIT = 10;

/** 只读子命令（不需要管理员） */
const READ_ONLY_SUBS = new Set([
  "",
  "help",
  "h",
  "?",
  "info",
  "status",
  "ping",
  "counts",
  "stat",
  "stats",
  "libs",
  "library",
  "users",
  "u",
  "user",
  "sessions",
  "online",
  "activity",
  "log",
  "search",
  "find",
]);

function ticksToClock(ticks?: number | null): string {
  if (!ticks || ticks <= 0) return "00:00";
  const total = Math.floor(ticks / 10_000_000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function progressBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${"▓".repeat(filled)}${"░".repeat(width - filled)} ${clamped.toFixed(0)}%`;
}

/**
 * Emby 返回的时间戳多为不带时区后缀的 UTC ISO 串，这里补 Z 后按服务器本地时区展示。
 * 手工格式化以避免依赖 ICU / locale 数据（部分精简镜像缺失）。
 */
function formatDate(input?: string | null): string {
  if (!input) return "—";
  try {
    let s = String(input);
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s = `${s}Z`;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(input);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(input);
  }
}

function splitMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) parts.push(current);
      // 单行超长时强制切断
      let rest = line;
      while (rest.length > maxLength) {
        parts.push(rest.slice(0, maxLength));
        rest = rest.slice(maxLength);
      }
      current = rest;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function randomPassword(len = 12): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** 统一发送/编辑消息，失败时回退为回复；超长自动分片 */
async function show(
  msg: Api.Message,
  text: string,
  parseMode: "html" | undefined = "html",
): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const payload: any = { parseMode };
    if (i === 0) {
      payload.text = chunks[i];
      try {
        await msg.edit(payload);
        continue;
      } catch {
        // 编辑失败（消息过旧 / 非本人消息）→ 回退为回复
      }
    }
    try {
      await msg.reply({ message: chunks[i], parseMode } as any);
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 发送消息失败:`, err);
    }
  }
}

function describeError(error: unknown): string {
  const err = error as any;
  if (!err) return "未知错误";
  const code = err.code || err.cause?.code;
  if (code === "ECONNREFUSED") return "连接被拒绝（服务未启动或端口错误）";
  if (code === "ENOTFOUND") return "域名解析失败";
  if (code === "ETIMEDOUT" || code === "ECONNABORTED") return "连接超时";
  if (code === "CERT_HAS_EXPIRED") return "HTTPS 证书已过期";
  return err.message || String(err);
}

// ────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────

interface EmbyServerEntry {
  url: string;
  apiKey: string;
  note?: string;
}

interface EmbyConfig {
  servers: Record<string, EmbyServerEntry>;
  default: string;
  admins: number[];
  readUsers: number[];
  readAll: boolean;
  alertChat: string;
  /** 使用白名单：非空时，只有名单内的 Telegram 用户 ID 能用本插件 */
  allowedUsers: number[];
  /**
   * 聊天白名单：非空时，来自这些聊天的命令视为授权。
   * 适合「读不到发送者 ID、但只用固定聊天发命令」的场景（比 ID 白名单好判定）。
   */
  allowedChats: number[];
  /**
   * 白名单非空时，TeleBox 管理员(sudo) 是否仍可用。
   * 默认 false —— 设了白名单就是要「只认名单」，否则白名单形同虚设。
   */
  allowSudo: boolean;
  /** 非白名单用户发命令时是否完全不回复（不暴露插件存在） */
  silentReject: boolean;
  /** 是否信任 bot 账号本人（出站命令的发送者）并自动登记为管理员，默认开 */
  trustAccountOwner?: boolean;
  /**
   * 手动指定「我」的 Telegram ID（0 = 关闭）。
   * 用于消息里根本读不到发送者、且自动推断会推断成账号本人（别人）的场景。
   */
  identityOverride: number;
}

const DEFAULT_CONFIG: EmbyConfig = {
  servers: {},
  default: "",
  admins: [],
  readUsers: [],
  readAll: false,
  alertChat: "",
  allowedUsers: [],
  allowedChats: [],
  allowSudo: false,
  silentReject: true,
  trustAccountOwner: true,
  identityOverride: 0,
};

// ────────────────────────────────────────────────────────────
// Emby API 客户端
// ────────────────────────────────────────────────────────────

class EmbyApi {
  readonly name: string;
  readonly origin: string;
  private readonly base: string;
  private readonly http: AxiosInstance;

  constructor(name: string, cfg: EmbyServerEntry) {
    this.name = name;
    this.origin = String(cfg.url || "").trim().replace(/\/+$/, "");
    this.base = /\/emby$/i.test(this.origin) ? this.origin : `${this.origin}/emby`;
    this.http = axios.create({
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 3,
      // Emby 自签证书很常见，这里跳过校验（仅本机/内网使用时风险可控）
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: {
        "X-Emby-Token": cfg.apiKey,
        "X-Emby-Authorization":
          'MediaBrowser Client="TeleBox", Device="TeleBox", DeviceId="telebox-emby", Version="1.0.0"',
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  }

  private async request<T = any>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    data?: unknown,
    params?: Record<string, unknown>,
  ): Promise<T> {
    let res;
    try {
      res = await this.http.request<T>({
        method,
        url: `${this.base}${url}`,
        data,
        params,
      });
    } catch (error) {
      throw new Error(describeError(error));
    }
    if (res.status >= 400) {
      let detail = "";
      const body: any = res.data;
      if (body && typeof body === "object") {
        detail = body.Message || body.message || body.error || "";
      } else if (typeof body === "string") {
        detail = body.slice(0, 200);
      }
      if (res.status === 401 || res.status === 403) {
        detail = detail || "API Key 无效或权限不足";
      }
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return res.data as T;
  }

  // — 系统 —
  systemInfo() {
    return this.request<any>("GET", "/System/Info");
  }

  counts() {
    return this.request<any>("GET", "/Items/Counts");
  }

  virtualFolders() {
    return this.request<any[]>("GET", "/Library/VirtualFolders");
  }

  activity(limit = 10) {
    return this.request<any>("GET", "/System/ActivityLog/Entries", undefined, {
      Limit: limit,
      StartIndex: 0,
    });
  }

  refreshLibrary(recursive = true) {
    return this.request<any>("POST", "/Library/Refresh", {}, { Recursive: recursive });
  }

  // — 用户 —
  users() {
    return this.request<any[]>("GET", "/Users");
  }

  user(userId: string) {
    return this.request<any>("GET", `/Users/${userId}`);
  }

  deleteUser(userId: string) {
    return this.request<any>("DELETE", `/Users/${userId}`);
  }

  createUser(name: string) {
    return this.request<any>("POST", "/Users/New", { Name: name });
  }

  updatePolicy(userId: string, policy: Record<string, unknown>) {
    return this.request<any>("POST", `/Users/${userId}/Policy`, policy);
  }

  setPassword(userId: string, newPassword: string, currentPassword = "") {
    return this.request<any>("POST", `/Users/${userId}/Password`, {
      CurrentPw: currentPassword,
      NewPw: newPassword,
    });
  }

  resetPassword(userId: string) {
    return this.request<any>("POST", `/Users/${userId}/Password`, {
      CurrentPw: "",
      NewPw: "",
      ResetPassword: true,
    });
  }

  // — 会话 —
  sessions() {
    return this.request<any[]>("GET", "/Sessions");
  }

  stopSession(sessionId: string) {
    return this.request<any>("POST", `/Sessions/${sessionId}/Playing/Stop`, {});
  }

  sendSessionMessage(sessionId: string, text: string, header = "TeleBox", timeoutMs = 8000) {
    return this.request<any>("POST", `/Sessions/${sessionId}/Message`, {
      Header: header,
      Text: text,
      TimeoutMs: timeoutMs,
    });
  }

  // — 媒体 —
  search(term: string, limit = DEFAULT_SEARCH_LIMIT) {
    return this.request<any>("GET", "/Items", undefined, {
      SearchTerm: term,
      Recursive: true,
      IncludeItemTypes: "Movie,Series,Episode,Video,MusicVideo,BoxSet",
      Limit: limit,
      Fields: "ProductionYear,Path,SeriesName",
    });
  }
}

// ────────────────────────────────────────────────────────────
// 插件主体
// ────────────────────────────────────────────────────────────

class EmbyPlugin extends Plugin {
  name = PLUGIN_NAME;

  private readonly HELP = `🧩 <b>Emby 管理插件</b>

<b>📝 功能:</b>
• 多服务器配置 / 切换，用户与权限管理
• 在线会话监控、停止播放、向播放端推送消息
• 媒体库统计、条目搜索、触发刷新

<b>🔧 服务器:</b>
• <code>${mainPrefix}emby s add &lt;名称&gt; &lt;URL&gt; &lt;APIKey&gt;</code> 添加
• <code>${mainPrefix}emby s list</code> 列表
• <code>${mainPrefix}emby s use &lt;名称&gt;</code> 设为默认
• <code>${mainPrefix}emby s test [名称]</code> 连通性测试
• <code>${mainPrefix}emby s del &lt;名称&gt;</code> 删除

<b>👥 用户:</b>
• <code>${mainPrefix}emby users [关键词]</code> 用户列表
• <code>${mainPrefix}emby user &lt;用户&gt;</code> 用户详情
• <code>${mainPrefix}emby on|off &lt;用户&gt;</code> 启用 / 禁用
• <code>${mainPrefix}emby admin &lt;用户&gt; on|off</code> 管理员权限
• <code>${mainPrefix}emby pwd &lt;用户&gt; [新密码]</code> 重置密码（省略则随机）
• <code>${mainPrefix}emby new &lt;用户名&gt; [密码]</code> 新建用户
• <code>${mainPrefix}emby del &lt;用户&gt;</code> 删除用户（需 <code>${mainPrefix}emby confirm</code>）

<b>📺 会话:</b>
• <code>${mainPrefix}emby sessions [all]</code> 在线播放（all 含空闲设备）
• <code>${mainPrefix}emby kick &lt;序号|用户&gt;</code> 停止播放
• <code>${mainPrefix}emby say &lt;序号|用户&gt; &lt;内容&gt;</code> 推送消息

<b>📚 媒体与系统:</b>
• <code>${mainPrefix}emby info</code> 服务器信息
• <code>${mainPrefix}emby counts</code> 媒体统计
• <code>${mainPrefix}emby libs</code> 媒体库列表
• <code>${mainPrefix}emby search &lt;关键词&gt; [数量]</code> 搜索
• <code>${mainPrefix}emby refresh</code> 刷新媒体库
• <code>${mainPrefix}emby activity [数量]</code> 活动日志

<b>🛡️ 权限 / 其他:</b>
• <code>${mainPrefix}emby whoami</code> 诊断：查看你自己的 Telegram ID / 解析来源
• <code>${mainPrefix}emby whoami raw</code> 打印消息原始字段（排查 ID 必发）
• <code>${mainPrefix}emby uid iam &lt;ID&gt;</code> 一条命令设定「我就是这个 ID」（含白名单+严格模式）
• <code>${mainPrefix}emby uid override &lt;ID&gt;</code> 仅指定「我」的 ID
• <code>${mainPrefix}emby uid whois</code> 回复某人消息 → 查其 ID
• <code>${mainPrefix}emby uid add me</code> 只允许自己使用（白名单）
• <code>${mainPrefix}emby uid only</code> 只认我 · <code>${mainPrefix}emby uid here</code> 只认当前聊天
• <code>${mainPrefix}emby uid chat list|add|del|clear</code> 聊天白名单
• <code>${mainPrefix}emby perm list|add &lt;uid&gt;|del &lt;uid&gt;|open|close</code>
• <code>${mainPrefix}emby confirm &lt;口令&gt;</code> 确认危险操作
• 任意命令前加 <code>@服务器名</code> 可临时指定服务器

<b>💡 示例:</b>
• <code>${mainPrefix}emby s add main http://127.0.0.1:8096 xxxxx</code>
• <code>${mainPrefix}emby @main users 张</code>`;

  description = "🧩 Emby 服务器管理（用户 / 会话 / 媒体库 / 活动日志）";

  private db: any = null;
  private sudoDB: SudoDB | null = null;
  private sweeper?: NodeJS.Timeout;
  /** 本 bot 账号自身的 Telegram ID（懒加载缓存） */
  private selfAccountId: number | null = null;

  /** 危险操作待确认队列：chatId:senderId → 待确认动作 */
  private pending = new Map<string, { action: string; token: string; expires: number }>();
  /** 会话列表缓存（供 kick / say 用序号引用） */
  private sessionCache = new Map<string, { at: number; sessions: any[] }>();

  constructor() {
    super();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    (this.sweeper as any)?.unref?.();
  }

  // ── 基础设施 ───────────────────────────────────────────

  private sweep(): void {
    const now = Date.now();
    for (const [key, item] of this.pending) {
      if (item.expires <= now) this.pending.delete(key);
    }
    for (const [key, item] of this.sessionCache) {
      if (now - item.at > SESSION_CACHE_TTL_MS) this.sessionCache.delete(key);
    }
  }

  private async getDB(): Promise<any> {
    if (this.db) return this.db;
    const dir = createDirectoryInAssets(PLUGIN_NAME);
    const dbPath = path.join(dir, "emby_config.json");
    this.db = await JSONFilePreset<EmbyConfig>(dbPath, { ...DEFAULT_CONFIG });
    // 补齐老配置缺失字段
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if ((this.db.data as any)[key] === undefined) {
        (this.db.data as any)[key] = Array.isArray(value) ? [] : value;
      }
    }
    await this.db.write();
    return this.db;
  }

  private async config(): Promise<EmbyConfig> {
    const db = await this.getDB();
    return db.data as EmbyConfig;
  }

  private async saveConfig(): Promise<void> {
    const db = await this.getDB();
    await db.write();
  }

  private sudo(): SudoDB {
    if (!this.sudoDB) this.sudoDB = new SudoDB();
    return this.sudoDB;
  }

  private sudoCount(): number {
    try {
      return this.sudo().ls().length;
    } catch {
      return 0;
    }
  }

  private isSudo(uid: number): boolean {
    try {
      return this.sudo().has(uid);
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 读取 sudo 列表失败:`, error);
      return false;
    }
  }

  /**
   * 本 bot 账号自身的 Telegram ID（即操作者本人）。
   * TeleBox 只对 `msg.out`（自己发出）的消息派发命令，所以出站消息的发送者就是账号本人。
   */
  private async getSelfAccountId(): Promise<number | null> {
    if (this.selfAccountId) return this.selfAccountId;
    try {
      const client: any = await getGlobalClient();
      const me: any = await client.getMe();
      const id = Number(me?.id);
      if (Number.isFinite(id) && id > 0) {
        this.selfAccountId = id;
        return id;
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] getMe 失败:`, error);
    }
    return null;
  }

  /**
   * 把任意值安全地转成 Telegram 用户 ID（正整数）。
   * 注意：不要用 Number(bool)，true 会变成 1。
   */
  private toId(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return null;
    let n: number;
    try {
      n = Number(value);
    } catch {
      return null;
    }
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  /** 安全转成「聊天 ID」：群/频道是负数（-100xxxx），不能复用只收正数的 toId */
  private toChatId(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return null;
    let n: number;
    try {
      n = Number(value);
    } catch {
      return null;
    }
    if (!Number.isFinite(n) || n === 0) return null;
    return n;
  }

  /**
   * 取出真实的 Telegram 用户 ID，并返回来源（用于诊断）。
   *
   * 坑 1：teleproto 的 `senderId` 只在 `fromId` 存在、或「非 out 的私聊消息」时才被赋值。
   * 坑 2：TeleBox 只对 `msg.out`（自己发出）或「收藏夹消息」派发命令。
   * 所以出站命令往往根本没有发送者字段；此时只能依据消息上下文推断，
   * 而推断可能得到「账号本人」而不是真正打字的人 —— 因此这里把来源标出来，
   * 并提供 config.identityOverride 让你能手动作废这种推断。
   */
  /**
   * 取「消息里真实携带的发送者 ID」——不掺杂任何 override / getMe 兜底。
   * 用于严格鉴权：只有消息本身能证明"是你发的"，才认你。
   */
  private realSenderId(msg: Api.Message): { id: number | null; source: string } {
    const m = msg as any;
    const explicit: Array<[string, unknown]> = [
      ["msg.senderId", m.senderId],
      ["msg.fromId.userId", m.fromId?.userId],
    ];
    try {
      explicit.push(["msg.sender.id", m.sender?.id]);
    } catch {
      /* sender 是惰性 getter，取不到就跳过 */
    }
    for (const [label, value] of explicit) {
      const id = this.toId(value);
      if (id) return { id, source: label };
    }
    // 别人发来的私聊消息：chatId 就是对方
    if (!m.out && this.toId(m.chatId)) {
      return { id: this.toId(m.chatId), source: "私聊对方（chatId）" };
    }
    return { id: null, source: "无真实发送者" };
  }

  private async resolveSenderId(
    msg: Api.Message,
  ): Promise<{ id: number | null; source: string }> {
    const cfg = await this.config();
    const m = msg as any;

    // ① 消息自带的真实发送者字段（最可靠，优先于一切）
    const real = this.realSenderId(msg);
    if (real.id) return real;

    // ② 手动指定身份（只有在读不到真实发送者时才生效 —— 方式 A 的兜底）
    if (cfg.identityOverride > 0) {
      return { id: cfg.identityOverride, source: "手动指定 identityOverride" };
    }

    // ③ 自己发出的消息：发送者就是本账号本人
    if (m.out) {
      const selfId = await this.getSelfAccountId();
      if (selfId) {
        return {
          id: selfId,
          source: cfg.trustAccountOwner
            ? "本账号本人（getMe，已按 trustAccountOwner 信任）"
            : "本账号本人（getMe，来源存疑）",
        };
      }
    }
    return { id: null, source: "无法确定" };
  }

  /** 带缓存地取发送者 ID（同一轮命令内只解析一次），来源缓存在消息对象上 */
  private async uidOf(msg: Api.Message): Promise<number | null> {
    const m = msg as any;
    if (typeof m.__embyUid === "number") return m.__embyUid;
    const { id, source } = await this.resolveSenderId(msg);
    if (id) {
      m.__embyUid = id;
      m.__embyUidSource = source;
    }
    return id;
  }

  private uidSourceOf(msg: Api.Message): string {
    return (msg as any).__embyUidSource || "未知";
  }

  /** 白名单成员：等同插件主人，读写全通 */
  private isOwner(uid: number, cfg?: EmbyConfig): boolean {
    const list = cfg?.allowedUsers ?? [];
    return list.length > 0 && list.includes(uid);
  }

  /**
   * 使用范围闸门：配置了 allowedUsers 时，只有名单内的人（以及可选的 sudo 成员）能触发插件。
   * silent=true 表示对未授权用户完全不回复，避免暴露插件存在。
   */
  private chatIdOf(msg: Api.Message): number | null {
    const m = msg as any;
    const direct = this.toChatId(m.chatId);
    if (direct) return direct;
    const peer = m.peerId;
    if (!peer) return null;
    if (peer.userId !== undefined) return this.toChatId(peer.userId);
    if (peer.channelId !== undefined) {
      const cid = this.toChatId(peer.channelId);
      return cid ? -1000000000000 - cid : null;
    }
    if (peer.chatId !== undefined) return -this.toChatId(peer.chatId)!;
    return null;
  }

  private async checkAccess(
    msg: Api.Message,
    uid: number,
  ): Promise<{ ok: boolean; silent: boolean }> {
    const cfg = await this.config();
    const hasUserList = cfg.allowedUsers.length > 0;
    const hasChatList = (cfg.allowedChats || []).length > 0;
    // 两个名单都没配 → 不启用范围限制（走管理员/只读规则）
    if (!hasUserList && !hasChatList) return { ok: true, silent: false };

    // 严格模式：名单已设，必须靠「消息里真实的发送者 ID」来判定，
    // 不接受 identityOverride / getMe 之类的推断兜底（否则任何人都能被当成主人）。
    const real = this.realSenderId(msg);
    const uidIsReal = real.id === uid;

    if (hasUserList) {
      if (cfg.allowedUsers.includes(uid) && uidIsReal) {
        return { ok: true, silent: false };
      }
    }

    const chatId = this.chatIdOf(msg);
    if (hasChatList && chatId && (cfg.allowedChats || []).includes(chatId)) {
      return { ok: true, silent: false };
    }

    // sudo 兜底：仅当 allowSudo=true 且 uid 是真实发送者才放行
    if (cfg.allowSudo && uidIsReal && this.isSudo(uid)) {
      return { ok: true, silent: false };
    }
    return { ok: false, silent: cfg.silentReject };
  }

  /** 当前聊天是否在白名单里（命中即视为插件主人） */
  private isAllowedChat(msg: Api.Message, cfg: EmbyConfig): boolean {
    const list = cfg.allowedChats || [];
    if (!list.length) return false;
    const chatId = this.chatIdOf(msg);
    return !!chatId && list.includes(chatId);
  }

  private async requireAdmin(msg: Api.Message, uid: number): Promise<boolean> {
    const cfg = await this.config();

    // 一旦设了白名单（用户名单或聊天名单），就必须严格只认名单，
    // 关闭「sudo 兜底」「引导兜底」「trustAccountOwner」等所有后门。
    const strict =
      cfg.allowedUsers.length > 0 || (cfg.allowedChats || []).length > 0;

    const real = this.realSenderId(msg);
    const uidIsReal = real.id === uid;

    if (strict) {
      // 严格模式：只认「真实发送者 ID 在白名单」或「真实发送者所在聊天在白名单」
      if (uidIsReal && this.isOwner(uid, cfg)) return true;
      if (this.isAllowedChat(msg, cfg)) return true;
      await show(
        msg,
        `🚫 <b>权限不足</b>\n\n当前为严格模式，仅白名单内的用户可用。\n你的 ID: <code>${uid}</code>（来源：${htmlEscape(this.uidSourceOf(msg))}）\n💡 让白名单成员执行 <code>${mainPrefix}emby uid add ${uid}</code>`,
      );
      return false;
    }

    // 宽松模式（未设白名单）：沿用 sudo / admins 判断
    if (this.isSudo(uid)) return true;
    if (cfg.admins.includes(uid) || this.isAllowedChat(msg, cfg)) return true;

    // 引导：sudo 列表为空时，第一个执行写操作的人自动成为管理员
    if (this.sudoCount() === 0) {
      try {
        const sender: any = msg.sender;
        this.sudo().add(
          uid,
          sender?.username || sender?.firstName || String(uid),
        );
        await show(
          msg,
          `🛡️ <b>已识别为管理员</b>\n\n已将你的 Telegram ID <code>${uid}</code> 登记到 sudo 列表（来源：${htmlEscape(this.uidSourceOf(msg))}）。\n如需调整：<code>${mainPrefix}sudo list</code>`,
        );
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] sudo 引导失败:`, error);
      }
      return true;
    }

    await show(
      msg,
      `🚫 <b>权限不足</b>\n\n该操作为写操作，仅限 TeleBox 管理员。\n你的 ID: <code>${uid}</code>（来源：${htmlEscape(this.uidSourceOf(msg))}）\n💡 让管理员执行 <code>${mainPrefix}sudo add ${uid}</code>\n💡 如果这个 ID 不对，用 <code>${mainPrefix}emby whoami</code> 排查，或用 <code>${mainPrefix}emby uid iam &lt;你的ID&gt;</code> 手动指定`,
    );
    return false;
  }

  private async requireRead(msg: Api.Message, uid: number): Promise<boolean> {
    const cfg = await this.config();
    const strict =
      cfg.allowedUsers.length > 0 || (cfg.allowedChats || []).length > 0;

    if (strict) {
      const real = this.realSenderId(msg);
      const uidIsReal = real.id === uid;
      if (uidIsReal && this.isOwner(uid, cfg)) return true;
      if (this.isAllowedChat(msg, cfg)) return true;
      await show(
        msg,
        `🚫 <b>权限不足</b>\n\n当前为严格模式，仅白名单内的用户可用。`,
      );
      return false;
    }

    if (this.isSudo(uid)) return true;
    if (
      this.isOwner(uid, cfg) ||
      cfg.admins.includes(uid) ||
      cfg.readAll ||
      this.isAllowedChat(msg, cfg)
    ) {
      return true;
    }
    if (cfg.readUsers.includes(uid)) return true;
    if (this.sudoCount() === 0) return true; // 未初始化时放行只读

    await show(
      msg,
      `🚫 <b>权限不足</b>\n\n只读命令同样需要授权。\n💡 管理员可执行 <code>${mainPrefix}emby perm add ${uid}</code>`,
    );
    return false;
  }

  private async api(serverArg?: string): Promise<EmbyApi> {
    const cfg = await this.config();
    const names = Object.keys(cfg.servers);
    if (names.length === 0) {
      throw new Error(
        `尚未配置任何 Emby 服务器\n请先执行 ${mainPrefix}emby s add <名称> <URL> <APIKey>`,
      );
    }
    const target = serverArg || cfg.default || names[0];
    const entry = cfg.servers[target];
    if (!entry) {
      throw new Error(`未找到服务器「${target}」\n可用: ${names.join("、")}`);
    }
    return new EmbyApi(target, entry);
  }

  /** 按服务器名取 API（用于确认队列，避免默认服务器被切换） */
  private async withApiByName(serverName: string): Promise<EmbyApi> {
    const cfg = await this.config();
    const entry = cfg.servers[serverName];
    if (!entry) throw new Error(`未找到服务器「${serverName}」`);
    return new EmbyApi(serverName, entry);
  }

  private confirmKey(msg: Api.Message): string {
    return `${msg.chatId ?? "?"}:${(msg as any).__embyUid ?? msg.senderId ?? "?"}`;
  }

  /**
   * 身份诊断：把消息里所有可能承载 TG ID 的字段都打出来，并说明最终来源。
   * 不校验任何权限（只暴露调用者自己的 ID），用于排查「读不到 TG ID / 读到别人的 ID」。
   */
  private async handleWhoami(msg: Api.Message, rest: string[] = []): Promise<void> {
    const mode = (rest[0] || "").toLowerCase();
    if (["raw", "json", "full", "dump"].includes(mode)) {
      const dump = this.rawDump(msg);
      const body = dump.length > 3200 ? `${dump.slice(0, 3200)}\n…(已截断)` : dump;
      await show(
        msg,
        `📦 <b>原始消息字段</b>\n\n<pre>${htmlEscape(body)}</pre>\n\n<i>把这段原样发给 Minis 即可定位 ID 在哪。</i>`,
      );
      return;
    }

    const m = msg as any;
    const fmt = (v: unknown): string => {
      if (v === undefined) return "undefined";
      if (v === null) return "null";
      if (typeof v === "boolean") return String(v);
      if (typeof v === "object") return this.dumpShort(v);
      try {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return String(n);
      } catch {
        /* ignore */
      }
      return String(v);
    };
    const safe = (fn: () => unknown): string => {
      try {
        return fmt(fn());
      } catch (error) {
        return `(读取失败: ${(error as any)?.message || "unknown"})`;
      }
    };
    const safeAsync = async (fn: () => unknown): Promise<string> => {
      try {
        const value = fn();
        const resolved = value instanceof Promise ? await value : value;
        return fmt(resolved);
      } catch (error) {
        return `(读取失败: ${(error as any)?.message || "unknown"})`;
      }
    };

    const cfg = await this.config();
    const resolved = await this.uidOf(msg);
    const selfId = await this.getSelfAccountId();
    const selfUser = await this.getSelfUserInfo();

    const senderIsSelf = !!resolved && !!selfId && resolved === selfId;
    const lines = [
      `🆔 <b>Telegram ID 诊断</b>`,
      ``,
      `<b>① 消息里的发送者字段</b>`,
      `• <code>msg.senderId</code>: ${fmt(m.senderId)}`,
      `• <code>msg.fromId</code>: ${fmt(m.fromId)}`,
      `• <code>msg.sender</code>: ${safe(() => m.sender)}`,
      `• <code>msg.savedPeerId</code>: ${fmt(m.savedPeerId)}`,
      ``,
      `<b>② 会话上下文</b>`,
      `• <code>msg.out</code>（是否自己发出）: ${fmt(m.out)}`,
      `• <code>msg.post</code>: ${fmt(m.post)}`,
      `• <code>msg.chatId</code>: ${fmt(m.chatId)}`,
      `• <code>msg.peerId</code>: ${fmt(m.peerId)}`,
      `• <code>getSender()</code>: ${await safeAsync(() => m.getSender?.())}`,
      `• <code>getChat()</code>: ${await safeAsync(() => m.getChat?.())}`,
      ``,
      `<b>③ 账号与配置</b>`,
      `• 本 bot 账号（getMe）: <code>${selfId ?? "取不到"}</code>${
        selfUser
          ? ` <i>${selfUser.username ? `@${htmlEscape(selfUser.username)}` : ""}${selfUser.bot ? " 🤖bot" : ""}</i>`
          : ""
      }`,
      `• 手动指定 identityOverride: <code>${cfg.identityOverride || "未设置"}</code>`,
      `• trustAccountOwner: <code>${cfg.trustAccountOwner !== false}</code>`,
      ``,
      `✅ <b>解析结果: ${resolved ?? "失败"}</b>`,
      `来源: ${htmlEscape(this.uidSourceOf(msg))}`,
      senderIsSelf
        ? `⚠️ 该发送者就是本 bot 账号本身（<code>${selfId}</code>）。TeleBox 只会派发「本账号自己发出」的消息，所以每条命令看到的都是这个 ID。`
        : ``,
    ];

    if (resolved) {
      lines.push(`在 sudo 列表: ${this.isSudo(resolved) ? "✅ 是" : "❌ 否"}`);
      if (cfg.identityOverride > 0) {
        lines.push(
          ``,
          `💡 身份是你手动指定的（<code>identityOverride</code>）。取消: <code>${mainPrefix}emby uid override off</code>`,
        );
      } else {
        lines.push(
          ``,
          `💡 如果这个 ID 不是你本人，一条命令改掉:`,
          `<code>${mainPrefix}emby uid iam &lt;你的ID&gt;</code>`,
        );
      }
    } else {
      lines.push(``, `⚠️ 所有字段都取不到 ID，请把上面几行发给我。`);
    }

    await show(msg, lines.join("\n"));
  }

  /** 本 bot 账号的完整信息（用于诊断） */
  private async getSelfUserInfo(): Promise<any> {
    try {
      const client: any = await getGlobalClient();
      const me: any = await client.getMe();
      return me;
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] getMe 失败:`, error);
      return null;
    }
  }

  /** 把消息对象的原始字段 dump 成 JSON（用于排查 ID 到底藏在哪） */
  private rawDump(msg: Api.Message): string {
    const m = msg as any;
    const record: Record<string, string> = {};
    const encode = (value: any): string => {
      try {
        return JSON.stringify(value, (_k, v) => {
          if (typeof v === "bigint") return `${v}n`;
          if (typeof v === "string" && v.length > 120) return `${v.slice(0, 120)}…`;
          return v;
        });
      } catch {
        return String(value);
      }
    };

    const keys = new Set<string>(Object.keys(m));
    // 原型上的惰性 getter 也要探一遍
    for (const k of ["senderId", "chatId", "sender", "chat", "inputSender", "savedPeerId", "userId"]) {
      keys.add(k);
    }

    for (const key of keys) {
      if (key === "client" || key.startsWith("__") || key === "_entities") continue;
      try {
        const value = m[key];
        if (typeof value === "function") continue;
        record[key] = encode(value);
      } catch (error) {
        record[key] = `(getter 抛错: ${(error as any)?.message || "unknown"})`;
      }
    }
    return JSON.stringify(record, null, 1);
  }
  /** 把对象压成一行简短的 "ClassName(k=v, ...)"，用于诊断输出 */
  private dumpShort(value: any, maxKeys = 6): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return String(value);
    const name = value.className || value.constructor?.name || "Object";
    const keys = Object.keys(value).filter((k) => !k.startsWith("_")).slice(0, maxKeys);
    const parts = keys.map((k) => {
      const v = value[k];
      if (v === null || v === undefined) return `${k}=${String(v)}`;
      if (typeof v === "object") return `${k}=<${v.className || "obj"}>`;
      return `${k}=${String(v)}`;
    });
    return `${name}(${parts.join(", ")})`;
  }

  private renderUserLine(u: any): { enabled: boolean; text: string } {
    const enabled = !u?.Policy?.IsDisabled;
    const admin = !!u?.Policy?.IsAdministrator;
    const badge = `${enabled ? "✅" : "🚫"}${admin ? " 👑" : ""}`;
    const last = u?.LastActivityDate || u?.LastLoginDate;
    return {
      enabled,
      text: `${badge} <code>${htmlEscape(u.Name)}</code>${
        last ? ` <i>${htmlEscape(formatDate(last))}</i>` : ""
      }`,
    };
  }

  private renderSessionLine(index: number, s: any): string {
    const np = s.NowPlayingItem || {};
    let title = np.Name || "未知条目";
    if (np.SeriesName) {
      const ep =
        np.ParentIndexNumber != null && np.IndexNumber != null
          ? ` S${String(np.ParentIndexNumber).padStart(2, "0")}E${String(np.IndexNumber).padStart(2, "0")}`
          : "";
      title = `${np.SeriesName}${ep} · ${np.Name}`;
    }
    const ps = s.PlayState || {};
    const total = np.RunTimeTicks || 0;
    const pos = ps.PositionTicks || 0;
    const percent = total > 0 ? (pos / total) * 100 : 0;
    const state = ps.IsPaused ? "⏸ 已暂停" : "▶️ 播放中";
    const device = [s.Client, s.DeviceName].filter(Boolean).join(" / ") || "未知设备";
    const lines = [
      `<b>${index}. ${htmlEscape(truncate(title, 60))}</b>`,
      `   👤 <code>${htmlEscape(s.UserName || "?")}</code> · ${state}`,
      `   📱 ${htmlEscape(truncate(device, 40))}`,
    ];
    if (total > 0) {
      lines.push(
        `   📊 <code>${ticksToClock(pos)} / ${ticksToClock(total)}</code> ${progressBar(percent)}`,
      );
    } else {
      lines.push(`   📊 ${progressBar(percent)}`);
    }
    return lines.join("\n");
  }

  // ── 命令入口 ───────────────────────────────────────────
  //
  // TeleBox 把「命令」（cmdHandlers）只派发给 `msg.out`（账号自己发出）或收藏夹消息，
  // 这种消息的 fromId 恒等于 bot 账号本身，拿不到真实发送者。
  //
  // 真实场景（方式 B）：用户是另一个号，把 bot 当服务号，发的命令对 bot 来说是「入站消息」，
  // fromId.userId 就是用户的真实 TG ID。所以要接住入站消息才能鉴权「你是谁」。
  //
  // 因此这里用两个入口：
  //   1) eventHandlers —— 用 NewMessage({incoming:true}) 精确接收入站消息（真实发送者）
  //   2) listenMessageHandler —— 兜底接收所有消息（同样能拿到入站 fromId）
  // 两者都自己解析前缀（. ／ 。／ $ 等），命中 emby/eb 就交给同一个 handle()。
  //
  // cmdHandlers 仍保留一份，兼容「在收藏夹里发命令」的旧用法。

  cmdHandlers = {
    emby: async (msg: Api.Message) => this.handle(msg),
    eb: async (msg: Api.Message) => this.handle(msg),
  };

  /**
   * 关键入口：监听【原始入站消息】，在消息被 TeleBox sudo 插件「重发」之前，
   * 拿到真实发送者（fromId.userId）。这是唯一能读到「你是谁」的地方。
   *
   * 背景（源码核实）：
   *   - TeleBox 的 dealCommandPlugin 只派发 msg.out（自己发出）或收藏夹消息；
   *   - 官方 sudo 插件用 listenMessageHandler 收到别人发的命令后，
   *     先 sendMessage 用机器人号「原样重发」一条，再把重发副本派发给 cmdHandlers；
   *   - 于是 cmdHandlers 拿到的永远是 out=true、fromId 空、senderId=机器人 的副本。
   *   - 而 listenMessageHandler 收到的是原始消息，fromId.userId 才是真实发送者。
   */
  listenMessageHandler = async (msg: Api.Message) => {
    if (this.isEmbyCommand(msg)) await this.handle(msg);
  };

  // 不再用 eventHandlers，避免与 listenMessageHandler 重复触发。
  // 若某版本 TeleBox 不传 listenMessageHandler，可回退启用下面的 eventHandlers。
  // eventHandlers = [
  //   {
  //     event: new NewMessage({ incoming: true }),
  //     handler: async (event: NewMessageEvent) => {
  //       const msg = event.message;
  //       if (this.isEmbyCommand(msg)) await this.handle(msg);
  //     },
  //   },
  // ];

  /**
   * 判断一条消息是否是发给本插件的命令（自己解析前缀 + emby/eb）。
   * listenMessageHandler / eventHandlers 不走命令路由，所以要手动识别。
   */
  private isEmbyCommand(msg: Api.Message): boolean {
    const text = (msg.text ?? (msg as any).message ?? "").trim() || "";
    if (!text) return false;
    const prefixes = [...getPrefixes(), "."];
    for (const p of prefixes) {
      if (!text.startsWith(p)) continue;
      const rest = text.slice(p.length).trimStart().toLowerCase();
      if (rest === "emby" || rest === "eb") return true;
      if (rest.startsWith("emby ") || rest.startsWith("eb ")) return true;
      const m = rest.match(/^@[^\s]+\s+(emby|eb)\b/);
      if (m) return true;
    }
    return false;
  }

  /**
   * 兜底监听：所有新消息（含入站）。与 eventHandlers 二选一即可，都挂会重复处理，
   * 因此以 eventHandlers 为主，不再额外注册 listenMessageHandler。
   * （若要改用 listenMessageHandler，把 eventHandlers 去掉并启用下面的方法。）
   */
  // listenMessageHandler = async (msg: Api.Message) => {
  //   if (this.isEmbyCommand(msg)) await this.handle(msg);
  // };

  private async handle(msg: Api.Message): Promise<void> {
    try {
      const args = (msg.text || "").trim().split(/\s+/).slice(1);
      let serverArg: string | undefined;

      if (args[0]?.startsWith("@") && args[0].length > 1) {
        serverArg = args.shift()!.slice(1);
      } else if ((args[0] === "-s" || args[0] === "--server") && args[1]) {
        args.shift();
        serverArg = args.shift()!;
      }

      const sub = (args[0] || "").toLowerCase();

      // 身份诊断命令：不校验任何权限，用于排查「读不到 TG ID」的问题
      if (["whoami", "id", "myid", "me"].includes(sub)) {
        await this.handleWhoami(msg, args.slice(1));
        return;
      }
      if (["whois", "who"].includes(sub)) {
        await this.handleWhois(msg);
        return;
      }

      const uid = await this.uidOf(msg);
      if (!uid) {
        await show(
          msg,
          `❓ <b>无法识别你的 Telegram ID</b>\n\n消息里没有 senderId / fromId，也没能取到本账号信息。\n请执行 <code>${mainPrefix}emby whoami</code> 查看诊断，或执行 <code>${mainPrefix}emby uid add &lt;你的ID&gt;</code>。`,
        );
        return;
      }

      // 使用范围闸门：未授权用户可被完全静默忽略
      const access = await this.checkAccess(msg, uid);
      if (!access.ok) {
        if (!access.silent) {
          await show(msg, `🚫 <b>无权限</b>\n本插件仅限指定用户使用。`);
        }
        return;
      }

      const serverAction = (args[1] || "list").toLowerCase();
      const isServerRead =
        (sub === "s" || sub === "server") &&
        ["list", "ls", "test", "ping"].includes(serverAction);

      if (!READ_ONLY_SUBS.has(sub) && !isServerRead) {
        if (!(await this.requireAdmin(msg, uid))) return;
      } else if (!(await this.requireRead(msg, uid))) {
        return;
      }

      await this.route(msg, sub, args.slice(1), serverArg, uid);
    } catch (error) {
      await show(
        msg,
        `❌ <b>操作失败</b>\n<code>${htmlEscape(describeError(error))}</code>`,
      );
    }
  }

  private async route(
    msg: Api.Message,
    sub: string,
    args: string[],
    serverArg: string | undefined,
    uid: number,
  ): Promise<void> {
    switch (sub) {
      case "":
      case "help":
      case "h":
      case "?":
        await show(msg, this.HELP);
        return;
      case "s":
      case "server":
        await this.handleServer(msg, args, serverArg);
        return;
      case "info":
      case "status":
        await this.handleInfo(msg, serverArg);
        return;
      case "ping":
        await this.handlePing(msg, serverArg);
        return;
      case "counts":
      case "stat":
      case "stats":
        await this.handleCounts(msg, serverArg);
        return;
      case "libs":
      case "library":
        await this.handleLibs(msg, serverArg);
        return;
      case "users":
      case "u":
        await this.handleUsers(msg, args, serverArg);
        return;
      case "user":
        await this.handleUserDetail(msg, args, serverArg);
        return;
      case "on":
      case "enable":
        await this.handleToggleUser(msg, args, serverArg, true);
        return;
      case "off":
      case "disable":
        await this.handleToggleUser(msg, args, serverArg, false);
        return;
      case "admin":
        await this.handleAdminFlag(msg, args, serverArg);
        return;
      case "pwd":
      case "passwd":
      case "password":
        await this.handlePassword(msg, args, serverArg);
        return;
      case "new":
      case "create":
        await this.handleCreateUser(msg, args, serverArg);
        return;
      case "del":
      case "delete":
      case "rm":
        await this.handleDeleteUser(msg, args, serverArg);
        return;
      case "sessions":
      case "online":
        await this.handleSessions(msg, args, serverArg);
        return;
      case "kick":
      case "stop":
        await this.handleKick(msg, args, serverArg);
        return;
      case "say":
      case "msg":
      case "tell":
        await this.handleSay(msg, args, serverArg);
        return;
      case "activity":
      case "log":
        await this.handleActivity(msg, args, serverArg);
        return;
      case "refresh":
      case "scan":
        await this.handleRefresh(msg, serverArg);
        return;
      case "search":
      case "find":
        await this.handleSearch(msg, args, serverArg);
        return;
      case "perm":
      case "permission":
        await this.handlePerm(msg, args);
        return;
      case "uid":
      case "ids":
      case "owner":
      case "scope":
        await this.handleUid(msg, args, uid);
        return;
      case "confirm":
      case "yes":
        await this.handleConfirm(msg, args);
        return;
      case "cancel":
        this.pending.delete(this.confirmKey(msg));
        await show(msg, "🚫 已取消待确认操作。");
        return;
      default:
        await show(
          msg,
          `❓ 未知子命令: <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}emby help</code> 查看帮助`,
        );
    }
  }

  // ── 服务器配置 ─────────────────────────────────────────

  private async handleServer(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const action = (args[0] || "list").toLowerCase();
    const cfg = await this.config();

    if (action === "add" || action === "new") {
      const [name, url, apiKey] = args.slice(1);
      if (!name || !url || !apiKey) {
        await show(
          msg,
          `❌ 用法: <code>${mainPrefix}emby s add &lt;名称&gt; &lt;URL&gt; &lt;APIKey&gt;</code>\n例: <code>${mainPrefix}emby s add main http://127.0.0.1:8096 abc123</code>`,
        );
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        await show(msg, "❌ URL 需以 http:// 或 https:// 开头");
        return;
      }
      const exists = !!cfg.servers[name];
      cfg.servers[name] = { url: url.replace(/\/+$/, ""), apiKey };
      if (!cfg.default) cfg.default = name;
      await this.saveConfig();

      // 顺手验证连通性
      let verify = "";
      try {
        const info = await new EmbyApi(name, cfg.servers[name]).systemInfo();
        verify = `\n✅ 连接成功：<b>${htmlEscape(info.ServerName || name)}</b> v${htmlEscape(info.Version || "?")}`;
      } catch (error) {
        verify = `\n⚠️ 已保存，但连接测试失败: <code>${htmlEscape(describeError(error))}</code>`;
      }
      await show(msg, `${exists ? "♻️ 已更新" : "✅ 已添加"}服务器 <b>${htmlEscape(name)}</b>${verify}`);
      return;
    }

    if (action === "list" || action === "ls") {
      const names = Object.keys(cfg.servers);
      if (names.length === 0) {
        await show(msg, `📭 尚无服务器配置\n💡 <code>${mainPrefix}emby s add &lt;名称&gt; &lt;URL&gt; &lt;APIKey&gt;</code>`);
        return;
      }
      const lines = ["🌐 <b>Emby 服务器列表</b>\n"];
      for (const n of names) {
        const s = cfg.servers[n];
        lines.push(
          `${n === cfg.default ? "⭐" : "▫️"} <b>${htmlEscape(n)}</b>\n   <code>${htmlEscape(s.url)}</code> · Key <code>${htmlEscape(s.apiKey.slice(0, 6))}***</code>`,
        );
      }
      lines.push(`\n⭐ = 默认服务器，切换: <code>${mainPrefix}emby s use &lt;名称&gt;</code>`);
      await show(msg, lines.join("\n"));
      return;
    }

    if (action === "use" || action === "switch" || action === "default") {
      const name = args[1];
      if (!name || !cfg.servers[name]) {
        await show(msg, `❌ 未找到服务器「${htmlEscape(name || "")}」`);
        return;
      }
      cfg.default = name;
      await this.saveConfig();
      await show(msg, `⭐ 默认服务器已切换为 <b>${htmlEscape(name)}</b>`);
      return;
    }

    if (action === "del" || action === "delete" || action === "rm") {
      const name = args[1];
      if (!name || !cfg.servers[name]) {
        await show(msg, `❌ 未找到服务器「${htmlEscape(name || "")}」`);
        return;
      }
      delete cfg.servers[name];
      if (cfg.default === name) cfg.default = Object.keys(cfg.servers)[0] || "";
      await this.saveConfig();
      await show(msg, `🗑️ 已删除服务器 <b>${htmlEscape(name)}</b>`);
      return;
    }

    if (action === "test" || action === "ping") {
      await this.handlePing(msg, args[1] || serverArg);
      return;
    }

    await show(
      msg,
      `❌ 未知操作: <code>${htmlEscape(action)}</code>\n用法: <code>add | list | use | del | test</code>`,
    );
  }

  private async handlePing(msg: Api.Message, serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const start = Date.now();
    const info = await api.systemInfo();
    const cost = Date.now() - start;
    await show(
      msg,
      `🏓 <b>${htmlEscape(api.name)}</b> 连接正常（${cost}ms）\n• 名称: ${htmlEscape(info.ServerName || "-")}\n• 版本: ${htmlEscape(info.Version || "-")}\n• 系统: ${htmlEscape(info.OperatingSystem || "-")}`,
    );
  }

  private async handleInfo(msg: Api.Message, serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const [info, counts] = await Promise.all([api.systemInfo(), api.counts().catch(() => null)]);
    const lines = [
      `🖥️ <b>${htmlEscape(info.ServerName || api.name)}</b>`,
      ``,
      `• 地址: <code>${htmlEscape(api.origin)}</code>`,
      `• 版本: <code>${htmlEscape(info.Version || "?")}</code>`,
      `• 系统: <code>${htmlEscape(info.OperatingSystem || "?")}</code>`,
      `• 架构: <code>${htmlEscape(info.SystemArchitecture || info.Architecture || "?")}</code>`,
      `• 运行环境: <code>${htmlEscape(info.OperatingSystemDisplayName || "-")}</code>`,
      `• 服务器 ID: <code>${htmlEscape(info.Id || "-")}</code>`,
    ];
    if (counts) {
      lines.push(
        ``,
        `📊 媒体: 电影 ${counts.MovieCount ?? 0} · 剧集 ${counts.SeriesCount ?? 0} · 单集 ${counts.EpisodeCount ?? 0}`,
      );
    }
    await show(msg, lines.join("\n"));
  }

  private async handleCounts(msg: Api.Message, serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const c = await api.counts();
    const rows: Array<[string, number]> = [
      ["🎬 电影", c.MovieCount],
      ["📺 剧集", c.SeriesCount],
      ["🎞️ 单集", c.EpisodeCount],
      ["🎵 歌曲", c.SongCount],
      ["💿 专辑", c.AlbumCount],
      ["🎤 艺人", c.ArtistCount],
      ["📦 合集", c.BoxSetCount],
      ["🎼 音乐视频", c.MusicVideoCount],
      ["📖 书籍", c.BookCount],
      ["📁 全部条目", c.ItemCount],
    ].filter(([, v]) => typeof v === "number") as Array<[string, number]>;

    const lines = [`📊 <b>${htmlEscape(api.name)} 媒体统计</b>`, ""];
    for (const [label, value] of rows) {
      lines.push(`${label}: <code>${value.toLocaleString()}</code>`);
    }
    await show(msg, lines.join("\n"));
  }

  private async handleLibs(msg: Api.Message, serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const folders = await api.virtualFolders();
    if (!folders?.length) {
      await show(msg, "📭 没有媒体库");
      return;
    }
    const lines = [`🗂️ <b>${htmlEscape(api.name)} 媒体库</b>`, ""];
    folders.forEach((f: any, i: number) => {
      const paths: string[] = Array.isArray(f.Locations) ? f.Locations : [];
      lines.push(
        `${i + 1}. <b>${htmlEscape(f.Name)}</b>${f.CollectionType ? ` <i>(${htmlEscape(f.CollectionType)})</i>` : ""}`,
      );
      for (const p of paths.slice(0, 3)) {
        lines.push(`   <code>${htmlEscape(truncate(p, 70))}</code>`);
      }
      if (paths.length > 3) lines.push(`   <i>… 共 ${paths.length} 个路径</i>`);
    });
    await show(msg, lines.join("\n"));
  }

  // ── 用户管理 ───────────────────────────────────────────

  private async resolveUser(api: EmbyApi, query: string): Promise<any> {
    if (!query) throw new Error("缺少用户名");
    const users = await api.users();
    const q = query.trim().toLowerCase();
    const exact = users.filter(
      (u: any) => String(u.Name).toLowerCase() === q || String(u.Id).toLowerCase() === q,
    );
    if (exact.length === 1) return exact[0];
    const fuzzy = users.filter((u: any) => String(u.Name).toLowerCase().includes(q));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length === 0) throw new Error(`未找到用户「${query}」`);
    const list = fuzzy
      .slice(0, 10)
      .map((u: any) => `• ${u.Name}`)
      .join("\n");
    throw new Error(`「${query}」匹配到 ${fuzzy.length} 个用户，请用更精确的名称:\n${list}`);
  }

  private async handleUsers(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const keyword = args.join(" ").trim().toLowerCase();
    let users = await api.users();
    if (keyword) {
      users = users.filter(
        (u: any) =>
          String(u.Name).toLowerCase().includes(keyword) ||
          String(u.Id).toLowerCase().includes(keyword),
      );
    }
    users.sort((a: any, b: any) => String(a.Name).localeCompare(String(b.Name), "zh-CN"));

    if (users.length === 0) {
      await show(msg, `📭 没有匹配的用户${keyword ? `: <code>${htmlEscape(keyword)}</code>` : ""}`);
      return;
    }

    const shown = users.slice(0, 200);
    const enabled = users.filter((u: any) => !u?.Policy?.IsDisabled).length;
    const lines = [
      `👥 <b>${htmlEscape(api.name)} 用户</b>（${users.length} 人，启用 ${enabled} / 禁用 ${users.length - enabled}）`,
      "",
    ];
    for (const u of shown) lines.push(this.renderUserLine(u).text);
    if (users.length > shown.length) lines.push(`\n<i>… 其余 ${users.length - shown.length} 人已省略</i>`);
    lines.push(`\n💡 <code>${mainPrefix}emby user &lt;名称&gt;</code> 查看详情`);
    await show(msg, lines.join("\n"));
  }

  private async handleUserDetail(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const u = await this.resolveUser(api, args.join(" ").trim());
    const policy = u.Policy || {};
    const lines = [
      `👤 <b>${htmlEscape(u.Name)}</b>`,
      "",
      `• ID: <code>${htmlEscape(u.Id)}</code>`,
      `• 状态: ${policy.IsDisabled ? "🚫 已禁用" : "✅ 启用"}${policy.IsHidden ? " · 🙈 隐藏" : ""}`,
      `• 管理员: ${policy.IsAdministrator ? "👑 是" : "否"}`,
      `• 密码: ${u.HasPassword ? "🔒 已设置" : "🔓 未设置"}${u.HasConfiguredPassword === false ? "（未配置）" : ""}`,
      `• 最后登录: <code>${htmlEscape(formatDate(u.LastLoginDate))}</code>`,
      `• 最后活动: <code>${htmlEscape(formatDate(u.LastActivityDate))}</code>`,
      `• 远程访问: ${policy.IsDisabledRemotely ? "禁用" : "允许"} · 下载: ${policy.EnableContentDownloading === false ? "关闭" : "开启"}`,
      `• 媒体库: ${policy.EnableAllFolders ? "全部" : `${(policy.EnabledFolders || []).length} 个指定库`}`,
    ];
    await show(msg, lines.join("\n"));
  }

  private async handleToggleUser(
    msg: Api.Message,
    args: string[],
    serverArg: string | undefined,
    enable: boolean,
  ): Promise<void> {
    const api = await this.api(serverArg);
    const u = await this.resolveUser(api, args.join(" ").trim());
    const policy = { ...(u.Policy || {}), IsDisabled: !enable };
    await api.updatePolicy(u.Id, policy);
    await show(
      msg,
      `${enable ? "✅ 已启用" : "🚫 已禁用"}用户 <b>${htmlEscape(u.Name)}</b>（${htmlEscape(api.name)}）`,
    );
  }

  private async handleAdminFlag(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const onoff = (args[args.length - 1] || "").toLowerCase();
    const namePart = ["on", "off", "yes", "no", "true", "false"].includes(onoff)
      ? args.slice(0, -1).join(" ")
      : args.join(" ");
    if (!["on", "off", "yes", "no", "true", "false"].includes(onoff)) {
      await show(
        msg,
        `❌ 用法: <code>${mainPrefix}emby admin &lt;用户&gt; on|off</code>`,
      );
      return;
    }
    const flag = ["on", "yes", "true"].includes(onoff);
    const api = await this.api(serverArg);
    const u = await this.resolveUser(api, namePart.trim());
    await api.updatePolicy(u.Id, { ...(u.Policy || {}), IsAdministrator: flag });
    await show(
      msg,
      `${flag ? "👑 已授予" : "✂️ 已取消"}用户 <b>${htmlEscape(u.Name)}</b> 的管理员权限`,
    );
  }

  private async handlePassword(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const namePart = args.slice(0, -1).join(" ").trim();
    const maybePwd = args.length > 1 ? args[args.length - 1] : "";

    // 情况一：`.emby pwd 用户名`（只有一个参数）→ 随机密码
    // 情况二：`.emby pwd 用户名 新密码` / `.emby pwd 用户名 reset`
    let user: any;
    let newPwd: string | null = null;
    let reset = false;

    if (args.length === 1) {
      user = await this.resolveUser(api, args[0]);
      newPwd = randomPassword();
    } else if (["reset", "clear", "none", "-"].includes(maybePwd.toLowerCase())) {
      try {
        user = await this.resolveUser(api, namePart);
        reset = true;
      } catch {
        user = await this.resolveUser(api, args.join(" "));
        newPwd = randomPassword();
      }
    } else {
      try {
        user = await this.resolveUser(api, namePart);
        newPwd = args[args.length - 1];
      } catch {
        user = await this.resolveUser(api, args.join(" "));
        newPwd = randomPassword();
      }
    }

    if (reset) {
      await api.resetPassword(user.Id);
      await show(msg, `🔓 已清除 <b>${htmlEscape(user.Name)}</b> 的密码`);
      return;
    }

    await api.setPassword(user.Id, newPwd!);
    await show(
      msg,
      `🔑 已重置 <b>${htmlEscape(user.Name)}</b> 的密码\n新密码: <code>${htmlEscape(newPwd!)}</code>\n\n<i>建议提醒用户尽快自行修改。</i>`,
    );
  }

  private async handleCreateUser(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const name = args[0];
    const pwd = args[1];
    if (!name) {
      await show(msg, `❌ 用法: <code>${mainPrefix}emby new &lt;用户名&gt; [密码]</code>`);
      return;
    }
    const api = await this.api(serverArg);
    const created = await api.createUser(name);
    let pwdLine = "";
    if (pwd) {
      await api.setPassword(created.Id, pwd);
      pwdLine = `\n密码: <code>${htmlEscape(pwd)}</code>`;
    }
    await show(
      msg,
      `✅ 已创建用户 <b>${htmlEscape(created.Name || name)}</b>（${htmlEscape(api.name)}）\nID: <code>${htmlEscape(created.Id)}</code>${pwdLine}`,
    );
  }

  private async handleDeleteUser(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    const u = await this.resolveUser(api, args.join(" ").trim());
    const token = String(Math.floor(1000 + Math.random() * 9000));
    this.pending.set(this.confirmKey(msg), {
      action: `delUser|${api.name}|${u.Id}|${u.Name}`,
      token,
      expires: Date.now() + CONFIRM_TTL_MS,
    });
    await show(
      msg,
      `⚠️ <b>危险操作确认</b>\n\n即将从 <b>${htmlEscape(api.name)}</b> 永久删除用户 <b>${htmlEscape(u.Name)}</b>\n<i>（含观看历史、播放记录，不可恢复）</i>\n\n确认请执行: <code>${mainPrefix}emby confirm ${token}</code>\n取消: <code>${mainPrefix}emby cancel</code>\n<i>3 分钟内有效</i>`,
    );
  }

  private async handleConfirm(msg: Api.Message, args: string[]): Promise<void> {
    const key = this.confirmKey(msg);
    const item = this.pending.get(key);
    const token = (args[0] || "").trim();

    if (!item || item.expires < Date.now()) {
      this.pending.delete(key);
      await show(msg, "⌛️ 没有待确认的操作（或已超时）");
      return;
    }
    if (item.token !== token) {
      await show(msg, `❌ 口令不正确\n💡 正确口令: <code>${item.token}</code>`);
      return;
    }
    this.pending.delete(key);

    const [action, ...rest] = item.action.split("|");
    if (action === "delUser") {
      const [serverName, userId, userName] = rest;
      const api = await this.withApiByName(serverName);
      await api.deleteUser(userId);
      await show(
        msg,
        `🗑️ 已从 <b>${htmlEscape(serverName)}</b> 删除用户 <b>${htmlEscape(userName)}</b>`,
      );
      return;
    }
    await show(msg, "❓ 未知的待确认操作，已忽略");
  }

  // ── 会话 ───────────────────────────────────────────────

  private async loadSessions(
    msg: Api.Message,
    api: EmbyApi,
    showIdle: boolean,
  ): Promise<{ playing: any[]; all: any[] }> {
    const all = await api.sessions();
    const playingList = all.filter((s: any) => !!s.NowPlayingItem);
    const target = showIdle ? all.filter((s: any) => !!s.UserId) : playingList;
    this.sessionCache.set(this.confirmKey(msg), {
      at: Date.now(),
      sessions: target,
    });
    return { playing: playingList, all };
  }

  private async handleSessions(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const showIdle = (args[0] || "").toLowerCase() === "all";
    const api = await this.api(serverArg);
    const { playing, all } = await this.loadSessions(msg, api, showIdle);

    const lines = [
      `📺 <b>${htmlEscape(api.name)} 会话</b>`,
      `在线设备 ${all.length} · 播放中 ${playing.length}`,
      "",
    ];

    if (showIdle) {
      if (all.length === 0) {
        await show(msg, `📭 没有在线设备`);
        return;
      }
      let index = 0;
      for (const s of all) {
        index++;
        if (s.NowPlayingItem) {
          lines.push(this.renderSessionLine(index, s));
        } else {
          const device = [s.Client, s.DeviceName].filter(Boolean).join(" / ") || "未知设备";
          lines.push(
            `<b>${index}. 💤 空闲</b>\n   👤 <code>${htmlEscape(s.UserName || "?")}</code> · 📱 ${htmlEscape(truncate(device, 40))}\n   🕐 ${htmlEscape(formatDate(s.LastActivityDate))}`,
          );
        }
        lines.push("");
      }
    } else {
      if (playing.length === 0) {
        await show(msg, `📭 <b>${htmlEscape(api.name)}</b> 当前没有正在播放的会话\n💡 查看全部设备: <code>${mainPrefix}emby sessions all</code>`);
        return;
      }
      playing.forEach((s: any, i: number) => {
        lines.push(this.renderSessionLine(i + 1, s));
        lines.push("");
      });
      lines.push(
        `💡 <code>${mainPrefix}emby kick &lt;序号&gt;</code> 停止 · <code>${mainPrefix}emby say &lt;序号&gt; &lt;内容&gt;</code> 推送`,
      );
    }

    await show(msg, lines.join("\n"));
  }

  private cachedSessions(msg: Api.Message): any[] {
    const entry = this.sessionCache.get(this.confirmKey(msg));
    if (!entry || Date.now() - entry.at > SESSION_CACHE_TTL_MS) return [];
    return entry.sessions;
  }

  /** 解析会话引用：数字=上次列表里的序号，其他=用户名（取其所有会话） */
  private async resolveSessions(
    msg: Api.Message,
    api: EmbyApi,
    ref: string,
    allowIdle = false,
  ): Promise<{ list: any[]; label: string; mode: "index" | "user"; idleFallback: boolean }> {
    if (/^\d+$/.test(ref)) {
      const index = Number(ref);
      let cached = this.cachedSessions(msg);
      if (cached.length === 0) {
        await this.loadSessions(msg, api, true);
        cached = this.cachedSessions(msg);
      }
      const s = cached[index - 1];
      if (!s) throw new Error(`序号 ${index} 不存在，请先执行 ${mainPrefix}emby sessions`);
      return { list: [s], label: s.UserName || `#${index}`, mode: "index", idleFallback: false };
    }
    const user = await this.resolveUser(api, ref);
    const all = await api.sessions();
    const mine = all.filter((s: any) => String(s.UserId) === String(user.Id));
    const playing = mine.filter((s: any) => !!s.NowPlayingItem);
    if (playing.length > 0) {
      return { list: playing, label: user.Name, mode: "user", idleFallback: false };
    }
    if (allowIdle && mine.length > 0) {
      // 没有播放会话时，仍向在线设备推送（客户端会以弹窗形式展示）
      return { list: mine, label: user.Name, mode: "user", idleFallback: true };
    }
    throw new Error(`用户「${user.Name}」当前没有正在播放的会话`);
  }

  private async handleKick(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const ref = (args[0] || "").trim();
    if (!ref) {
      await show(msg, `❌ 用法: <code>${mainPrefix}emby kick &lt;序号|用户名&gt;</code>`);
      return;
    }
    const api = await this.api(serverArg);
    const { list, label } = await this.resolveSessions(msg, api, ref);
    for (const s of list) {
      await api.stopSession(s.Id);
    }
    await show(msg, `⏹️ 已停止 <b>${htmlEscape(label)}</b> 的 ${list.length} 个播放会话`);
  }

  private async handleSay(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const ref = (args[0] || "").trim();
    const text = args.slice(1).join(" ").trim();
    if (!ref || !text) {
      await show(
        msg,
        `❌ 用法: <code>${mainPrefix}emby say &lt;序号|用户名&gt; &lt;内容&gt;</code>`,
      );
      return;
    }
    const api = await this.api(serverArg);
    const { list, label, idleFallback } = await this.resolveSessions(msg, api, ref, true);
    let ok = 0;
    for (const s of list) {
      try {
        await api.sendSessionMessage(s.Id, text);
        ok++;
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] 会话消息发送失败:`, error);
      }
    }
    await show(
      msg,
      ok > 0
        ? `📨 已向 <b>${htmlEscape(label)}</b> 的 ${ok} 个在线设备推送消息${
            idleFallback ? "\n<i>（该用户未在播放，消息已推送到空闲设备）</i>" : ""
          }`
        : `❌ 消息推送失败（客户端可能不支持）`,
    );
  }

  // ── 媒体与系统 ─────────────────────────────────────────

  private async handleActivity(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    const limit = Math.min(Math.max(parseInt(args[0] || "10", 10) || 10, 1), 50);
    const api = await this.api(serverArg);
    const res = await api.activity(limit);
    const items: any[] = res?.Items || [];
    if (items.length === 0) {
      await show(msg, "📭 没有活动记录");
      return;
    }
    const lines = [`📜 <b>${htmlEscape(api.name)} 最近活动</b>`, ""];
    for (const it of items) {
      const text = it.ShortOverview || it.Overview || it.Name || "";
      lines.push(
        `• <b>${htmlEscape(it.Name || it.Type || "活动")}</b>\n   ${htmlEscape(truncate(text, 120))}\n   🕐 <i>${htmlEscape(formatDate(it.Date))}</i>`,
      );
    }
    await show(msg, lines.join("\n"));
  }

  private async handleSearch(msg: Api.Message, args: string[], serverArg?: string): Promise<void> {
    let limit = DEFAULT_SEARCH_LIMIT;
    const maybeLimit = args[args.length - 1];
    let termParts = args;
    if (args.length > 1 && /^\d+$/.test(maybeLimit)) {
      limit = Math.min(Math.max(parseInt(maybeLimit, 10), 1), 30);
      termParts = args.slice(0, -1);
    }
    const term = termParts.join(" ").trim();
    if (!term) {
      await show(msg, `❌ 用法: <code>${mainPrefix}emby search &lt;关键词&gt; [数量]</code>`);
      return;
    }
    const api = await this.api(serverArg);
    const res = await api.search(term, limit);
    const items: any[] = res?.Items || [];
    if (items.length === 0) {
      await show(msg, `🔍 <b>${htmlEscape(term)}</b> 无结果`);
      return;
    }
    const iconOf: Record<string, string> = {
      Movie: "🎬",
      Series: "📺",
      Episode: "🎞️",
      Video: "🎥",
      MusicVideo: "🎼",
      BoxSet: "📦",
    };
    const lines = [
      `🔍 <b>${htmlEscape(term)}</b> — ${res.TotalRecordCount ?? items.length} 个结果（显示 ${items.length}）`,
      "",
    ];
    items.forEach((it: any, i: number) => {
      const icon = iconOf[it.Type] || "📄";
      const year = it.ProductionYear ? ` (${it.ProductionYear})` : "";
      let title = it.Name;
      if (it.Type === "Episode" && it.SeriesName) {
        title = `${it.SeriesName} — ${it.Name}`;
      }
      lines.push(`${i + 1}. ${icon} <b>${htmlEscape(truncate(String(title), 80))}</b>${year}`);
      lines.push(`   <code>${htmlEscape(it.Id)}</code>`);
    });
    await show(msg, lines.join("\n"));
  }

  private async handleRefresh(msg: Api.Message, serverArg?: string): Promise<void> {
    const api = await this.api(serverArg);
    await api.refreshLibrary(true);
    await show(msg, `🔄 已触发 <b>${htmlEscape(api.name)}</b> 媒体库刷新\n<i>扫描在后台进行，完成后可在活动日志查看。</i>`);
  }

  // ── 权限管理 ───────────────────────────────────────────

  private async handlePerm(msg: Api.Message, args: string[]): Promise<void> {
    const action = (args[0] || "list").toLowerCase();
    const cfg = await this.config();

    if (action === "list" || action === "ls") {
      const lines = [
        "🛡️ <b>Emby 插件权限</b>",
        "",
        `• readAll: <code>${cfg.readAll}</code>`,
        `• 只读白名单: ${cfg.readUsers.length ? cfg.readUsers.map((x) => `<code>${x}</code>`).join(" ") : "（空）"}`,
        `• 附加管理员: ${cfg.admins.length ? cfg.admins.map((x) => `<code>${x}</code>`).join(" ") : "（空）"}`,
        "",
        `💡 TeleBox 管理员（sudo）始终拥有全部权限。`,
      ];
      await show(msg, lines.join("\n"));
      return;
    }

    if (action === "open" || action === "close") {
      cfg.readAll = action === "open";
      await this.saveConfig();
      await show(msg, `🔓 只读命令已${cfg.readAll ? "对所有人开放" : "仅限白名单"}`);
      return;
    }

    if (action === "add" || action === "del" || action === "rm") {
      const uid = Number((args[1] || "").replace(/[^\d]/g, ""));
      if (!uid) {
        await show(msg, `❌ 用法: <code>${mainPrefix}emby perm ${action} &lt;TG用户ID&gt;</code>`);
        return;
      }
      if (action === "add") {
        if (!cfg.readUsers.includes(uid)) cfg.readUsers.push(uid);
      } else {
        cfg.readUsers = cfg.readUsers.filter((x) => x !== uid);
      }
      await this.saveConfig();
      await show(
        msg,
        `${action === "add" ? "✅ 已添加" : "🗑️ 已移除"}只读用户 <code>${uid}</code>`,
      );
      return;
    }

    await show(
      msg,
      `❌ 未知操作: <code>${htmlEscape(action)}</code>\n用法: <code>list | add &lt;uid&gt; | del &lt;uid&gt; | open | close</code>`,
    );
  }

  // ── 使用范围（仅限指定 Telegram ID）──────────────────────

  /** 从参数里解析 Telegram 用户 ID；支持 me / @username / 纯数字，支持一次多个 */
  private async resolveIdArgs(
    msg: Api.Message,
    raw: string[],
    myId: number,
  ): Promise<{ ids: number[]; notes: string[]; errors: string[] }> {
    const ids: number[] = [];
    const notes: string[] = [];
    const errors: string[] = [];

    for (const token of raw) {
      const t = String(token || "").trim();
      if (!t) continue;
      const lower = t.toLowerCase();

      if (["me", "我", "self", "自己"].includes(lower)) {
        ids.push(myId);
        notes.push(`me → ${myId}`);
        continue;
      }

      if (t.startsWith("@")) {
        try {
          const client: any = await getGlobalClient();
          const entity: any = await client.getEntity(t);
          const id = this.toId(entity?.id);
          if (id) {
            ids.push(id);
            notes.push(`${t} → ${id}`);
          } else {
            errors.push(`${t}: 不是有效用户`);
          }
        } catch (error) {
          errors.push(`${t}: ${describeError(error)}`);
        }
        continue;
      }

      const id = this.toId(t.replace(/[^\d]/g, ""));
      if (id) {
        ids.push(id);
        continue;
      }
      errors.push(`${t}: 无法识别（可回复对方消息后执行本命令）`);
    }

    // 没有显式参数时，尝试用「被回复的那条消息」的发送者
    if (ids.length === 0 && raw.length === 0) {
      const reply = await this.getReplyInfo(msg);
      if (reply.id) {
        ids.push(reply.id);
        notes.push(`回复消息的发送者 → ${reply.id}`);
      } else if (reply.error) {
        errors.push(reply.error);
      }
    }

    return { ids: [...new Set(ids)], notes, errors };
  }

  /** 读取被回复消息的发送者信息 */
  private async getReplyInfo(
    msg: Api.Message,
  ): Promise<{ id: number | null; label: string; error?: string }> {
    let reply: any = null;
    try {
      reply = await (msg as any).getReplyMessage?.();
    } catch (error) {
      return { id: null, label: "", error: `读取回复消息失败: ${describeError(error)}` };
    }
    if (!reply) return { id: null, label: "", error: "没有回复任何消息，也不是可用的 ID" };

    const id =
      this.toId(reply.fromId?.userId) ??
      this.toId(reply.senderId) ??
      this.toId(reply.sender?.id);
    const label = reply.sender?.firstName || reply.sender?.username || "";
    if (!id) {
      return {
        id: null,
        label,
        error:
          "被回复的消息没有用户发送者（可能是频道/群组消息或自己通过收藏夹转发的消息）",
      };
    }
    return { id, label };
  }

  /** 只读：查看被回复消息的发送者 ID */
  private async handleWhois(msg: Api.Message): Promise<void> {
    const info = await this.getReplyInfo(msg);
    if (!info.id) {
      await show(
        msg,
        `❌ 无法识别\n${htmlEscape(info.error || "请回复一条对方发送的消息")}`,
      );
      return;
    }
    await show(
      msg,
      `🔎 <b>被回复消息的发送者</b>\n\n• ID: <code>${info.id}</code>${
        info.label ? `\n• 名称: ${htmlEscape(info.label)}` : ""
      }\n\n💡 加进白名单: <code>${mainPrefix}emby uid add ${info.id}</code>`,
    );
  }

  private async handleUid(msg: Api.Message, args: string[], uid: number): Promise<void> {
    const cfg = await this.config();
    const myId = uid;
    const action = (args[0] || "list").toLowerCase();
    const rest = args.slice(1);

    /**
     * 模拟「改成 next 之后，我自己还能不能进来」。
     * 防止把关卡设置成把自己锁在门外。
     */
    const canStillManage = (
      nextUsers: number[],
      nextChats: number[],
      nextAllowSudo = cfg.allowSudo,
    ): boolean => {
      const myChat = this.chatIdOf(msg);
      if (nextUsers.length === 0 && nextChats.length === 0) {
        // 名单全空 → 回退管理员规则
        return this.isSudo(myId);
      }
      if (nextUsers.includes(myId)) return true;
      if (myChat && nextChats.includes(myChat)) return true;
      if (nextAllowSudo && this.isSudo(myId)) return true;
      return false;
    };

    const lockedMsg =
      `⚠️ <b>已阻止</b>\n\n这样改完后你将无法再管理本插件（<code>${myId}</code> 与当前聊天都不在名单里，sudo 也被排除）。\n\n` +
      `请先保留自己（<code>${mainPrefix}emby uid add me</code> 或 <code>${mainPrefix}emby uid here</code>），或执行 <code>${mainPrefix}emby uid sudo on</code>。`;

    const lockoutGuard = (next: number[]): string | null =>
      canStillManage(next, cfg.allowedChats || []) ? null : lockedMsg;

    const renderList = (): string => {
      const lines = [`🎯 <b>插件使用范围</b>`, ""];
      lines.push(`• 你的 Telegram ID: <code>${myId}</code>`);
      if (cfg.allowedUsers.length === 0) {
        lines.push(`• 白名单: <b>未启用</b>（当前按 TeleBox 管理员 / 只读白名单鉴权）`);
      } else {
        lines.push(
          `• 白名单（${cfg.allowedUsers.length} 人，读写全通）:`,
          ...cfg.allowedUsers.map(
            (id) => `   ${id === myId ? "👉" : "▫️"} <code>${id}</code>`,
          ),
        );
      }
      lines.push(
        `• 当前聊天 ID: <code>${this.chatIdOf(msg) ?? "未知"}</code>`,
        `• 聊天白名单: ${
          (cfg.allowedChats || []).length
            ? (cfg.allowedChats || []).map((c) => `<code>${c}</code>`).join(" ")
            : "（空）"
        }`,
        `• 手动指定身份: <code>${cfg.identityOverride || "未设置"}</code>`,
        `• sudo 成员仍可用: <code>${cfg.allowSudo}</code>`,
        `• 未授权用户静默忽略: <code>${cfg.silentReject}</code>`,
        "",
        `💡 <code>${mainPrefix}emby uid only</code> 只认我 · <code>${mainPrefix}emby uid here</code> 只认当前聊天`,
      );
      return lines.join("\n");
    };

    switch (action) {
      case "list":
      case "ls":
      case "": {
        await show(msg, renderList());
        return;
      }

      case "me":
      case "my": {
        await show(
          msg,
          `🆔 你的 Telegram ID: <code>${myId}</code>\n<i>来源: ${htmlEscape(this.uidSourceOf(msg))}</i>\n\n添加: <code>${mainPrefix}emby uid add ${myId}</code>\n若不是你本人: <code>${mainPrefix}emby uid override &lt;你的ID&gt;</code>`,
        );
        return;
      }

      case "whois":
      case "who": {
        await this.handleWhois(msg);
        return;
      }

      case "chat":
      case "here":
      case "room": {
        const chatId = this.chatIdOf(msg);
        const sub2 = (rest[0] || (action === "here" ? "add" : "list")).toLowerCase();
        const list = cfg.allowedChats || [];

        if (sub2 === "list" || sub2 === "ls") {
          await show(
            msg,
            `💬 <b>聊天白名单</b>\n\n• 当前聊天 ID: <code>${chatId ?? "未知"}</code>\n• 名单: ${
              list.length ? list.map((c) => `<code>${c}</code>`).join(" ") : "（空）"
            }\n\n💡 加入当前聊天: <code>${mainPrefix}emby uid here</code>`,
          );
          return;
        }

        if (["add", "only"].includes(sub2)) {
          const target = this.toChatId(rest[1]) ?? chatId;
          if (!target) {
            await show(msg, "❌ 取不到当前聊天 ID，请显式指定：<code>uid chat add &lt;聊天ID&gt;</code>");
            return;
          }
          const next = sub2 === "only" ? [target] : [...new Set([...list, target])];
          if (!canStillManage(cfg.allowedUsers, next)) {
            await show(msg, lockedMsg);
            return;
          }
          cfg.allowedChats = next;
          await this.saveConfig();
          await show(
            msg,
            `✅ 已允许聊天 <code>${target}</code>${sub2 === "only" ? "（并清空了其他聊天）" : ""}\n` +
              `该聊天里的命令将视为授权（读写全通）。\n\n${renderList()}`,
          );
          return;
        }

        if (["del", "rm", "remove"].includes(sub2)) {
          const target = this.toChatId(rest[1]) ?? chatId;
          if (!target) {
            await show(msg, "❌ 用法: <code>uid chat del &lt;聊天ID&gt;</code>");
            return;
          }
          const nextChats = list.filter((c) => c !== target);
          if (!canStillManage(cfg.allowedUsers, nextChats)) {
            await show(msg, lockedMsg);
            return;
          }
          cfg.allowedChats = nextChats;
          await this.saveConfig();
          await show(msg, `🗑️ 已移除聊天 <code>${target}</code>`);
          return;
        }

        if (["clear", "off", "reset"].includes(sub2)) {
          if (!canStillManage(cfg.allowedUsers, [])) {
            await show(msg, lockedMsg);
            return;
          }
          cfg.allowedChats = [];
          await this.saveConfig();
          await show(msg, "🔓 聊天白名单已清空");
          return;
        }

        await show(
          msg,
          `❌ 未知操作: <code>${htmlEscape(sub2)}</code>\n用法: <code>uid chat list | add [聊天ID] | del [聊天ID] | clear</code>`,
        );
        return;
      }

      case "iam":
      case "thisisme":
      case "bindme": {
        // 一条命令完成「我就是这个 ID」的全部配置
        const parsed = await this.resolveIdArgs(msg, rest, myId);
        const id = parsed.ids[0];
        if (!id) {
          await show(
            msg,
            `❌ 用法: <code>${mainPrefix}emby uid iam &lt;你的TG_ID&gt;</code>\n` +
              `💡 例: <code>${mainPrefix}emby uid iam 8017322668</code>\n` +
              (parsed.errors.length
                ? `⚠️ ${parsed.errors.map((e) => htmlEscape(e)).join("\n⚠️ ")}`
                : ""),
          );
          return;
        }
        cfg.identityOverride = id;
        cfg.allowedUsers = [...new Set([...(cfg.allowedUsers || []), id])];
        cfg.allowSudo = false;
        await this.saveConfig();
        await show(
          msg,
          `🎯 <b>已把你设为 <code>${id}</code></b>\n\n` +
            `• 身份解析: 手动指定（不再依赖消息里的发送者）\n` +
            `• 白名单: 只有 <code>${id}</code> 可用\n` +
            `• sudo 兜底: 已关闭（严格模式）\n\n` +
            `现在起：把 <code>${id}</code> 当作你本人，其它来源一律静默忽略。\n` +
            `取消: <code>${mainPrefix}emby uid override off</code> · 查看: <code>${mainPrefix}emby uid</code>`,
        );
        return;
      }

      case "override":
      case "bind": {
        const value = (rest[0] || "").toLowerCase();
        if (!value) {
          await show(
            msg,
            `当前手动指定身份: <code>${cfg.identityOverride || "未设置"}</code>\n\n` +
              `用法: <code>${mainPrefix}emby uid override &lt;你的ID&gt;</code> · 取消: <code>${mainPrefix}emby uid override off</code>\n` +
              `💡 不知道自己的 ID？回复自己的一条消息执行 <code>${mainPrefix}emby uid whois</code>`,
          );
          return;
        }
        if (["off", "clear", "none", "reset", "0"].includes(value)) {
          cfg.identityOverride = 0;
          await this.saveConfig();
          await show(msg, "🧹 已取消手动指定身份，恢复自动解析（可用 <code>whoami</code> 查看）");
          return;
        }
        const parsed = await this.resolveIdArgs(msg, rest, myId);
        const id = parsed.ids[0];
        if (!id) {
          await show(
            msg,
            `❌ 无法解析这个 ID${parsed.errors.length ? `\n⚠️ ${parsed.errors.map((e) => htmlEscape(e)).join("\n⚠️ ")}` : ""}`,
          );
          return;
        }
        cfg.identityOverride = id;
        await this.saveConfig();
        await show(
          msg,
          `🎯 已手动指定操作者身份为 <code>${id}</code>\n之后所有命令都按该 ID 鉴权（<code>${mainPrefix}emby uid override off</code> 取消）。\n\n` +
            `建议顺便加入白名单: <code>${mainPrefix}emby uid add ${id}</code> → 然后 <code>${mainPrefix}emby uid only</code>`,
        );
        return;
      }

      case "add": {
        const { ids, notes, errors } = await this.resolveIdArgs(msg, rest, myId);
        if (ids.length === 0) {
          await show(
            msg,
            `❌ 用法: <code>${mainPrefix}emby uid add &lt;ID…&gt;|me|@用户名</code>\n` +
              `💡 也可以「回复对方的消息」后直接执行本命令，或 <code>${mainPrefix}emby uid add me</code>\n` +
              (errors.length ? `\n⚠️ ${errors.map((e) => htmlEscape(e)).join("\n⚠️ ")}` : ""),
          );
          return;
        }
        for (const id of ids) {
          if (!cfg.allowedUsers.includes(id)) cfg.allowedUsers.push(id);
        }
        await this.saveConfig();
        await show(
          msg,
          `✅ 已加入白名单: ${ids.map((i) => `<code>${i}</code>`).join("、")}` +
            (notes.length ? `\n<i>来源: ${notes.map((n) => htmlEscape(n)).join("；")}</i>` : "") +
            `\n\n${renderList()}`,
        );
        return;
      }

      case "del":
      case "rm":
      case "remove": {
        const { ids, errors } = await this.resolveIdArgs(msg, rest, myId);
        if (ids.length === 0) {
          await show(
            msg,
            `❌ 用法: <code>${mainPrefix}emby uid del &lt;ID…&gt;|me|@用户名</code>（也可回复对方消息）` +
              (errors.length ? `\n⚠️ ${errors.map((e) => htmlEscape(e)).join("\n⚠️ ")}` : ""),
          );
          return;
        }
        const next = cfg.allowedUsers.filter((id) => !ids.includes(id));
        const blocked = lockoutGuard(next);
        if (blocked) {
          await show(msg, blocked);
          return;
        }
        cfg.allowedUsers = next;
        await this.saveConfig();
        await show(
          msg,
          `🗑️ 已从白名单移除: ${ids.map((i) => `<code>${i}</code>`).join("、")}\n\n${renderList()}`,
        );
        return;
      }

      case "only":
      case "just": {
        const parsed = await this.resolveIdArgs(msg, rest, myId);
        const ids = parsed.ids;
        if (ids.length === 0) ids.push(myId);
        const next = [...new Set(ids)];
        const blocked = lockoutGuard(next);
        if (blocked) {
          await show(msg, blocked);
          return;
        }
        cfg.allowedUsers = next;
        await this.saveConfig();
        await show(msg, `🎯 已设为仅以下 ID 可用:\n${cfg.allowedUsers.map((i) => `• <code>${i}</code>`).join("\n")}`);
        return;
      }

      case "clear":
      case "off":
      case "reset": {
        const blocked = lockoutGuard([]);
        if (blocked) {
          await show(msg, blocked);
          return;
        }
        cfg.allowedUsers = [];
        await this.saveConfig();
        await show(msg, `🔓 白名单已清空，鉴权回退到 TeleBox 管理员 / 只读白名单规则`);
        return;
      }

      case "silent": {
        const value = (rest[0] || "").toLowerCase();
        if (!["on", "off", "yes", "no", "true", "false"].includes(value)) {
          await show(msg, `❌ 用法: <code>${mainPrefix}emby uid silent on|off</code>`);
          return;
        }
        cfg.silentReject = ["on", "yes", "true"].includes(value);
        await this.saveConfig();
        await show(
          msg,
          `🔇 未授权用户${cfg.silentReject ? "将被<strong>完全静默忽略</strong>" : "会收到「无权限」提示"}`,
        );
        return;
      }

      case "sudo": {
        const value = (rest[0] || "").toLowerCase();
        if (!["on", "off", "yes", "no", "true", "false"].includes(value)) {
          await show(msg, `❌ 用法: <code>${mainPrefix}emby uid sudo on|off</code>`);
          return;
        }
        const next = ["on", "yes", "true"].includes(value);
        if (!next && !canStillManage(cfg.allowedUsers, cfg.allowedChats || [], false)) {
          await show(msg, lockedMsg);
          return;
        }
        cfg.allowSudo = next;
        await this.saveConfig();
        await show(
          msg,
          `🛡️ TeleBox 管理员${cfg.allowSudo ? "仍可使用本插件" : "已被排除，严格只认白名单"}\n<i>请确认白名单里有你自己（<code>${myId}</code>）</i>`,
        );
        return;
      }

      default:
        await show(
          msg,
          `❌ 未知操作: <code>${htmlEscape(action)}</code>\n用法: <code>list | iam &lt;你的ID&gt; | add &lt;ID|me|@用户名&gt; | del &lt;ID&gt; | only [ID] | here | chat … | clear | whois | override &lt;ID|off&gt; | silent on|off | sudo on|off | me</code>`,
        );
    }
  }

  // ── 定时任务 ───────────────────────────────────────────

  cronTasks = {
    embyHealthCheck: {
      cron: "0 */6 * * *",
      description: "Emby 服务器健康巡检（异常时通知）",
      handler: async (client: TelegramClient) => {
        try {
          const cfg = await this.config();
          const chat = cfg.alertChat;
          const failed: string[] = [];
          for (const [name, entry] of Object.entries(cfg.servers)) {
            try {
              await new EmbyApi(name, entry).systemInfo();
            } catch (error) {
              failed.push(`• <b>${htmlEscape(name)}</b>: ${htmlEscape(describeError(error))}`);
            }
          }
          if (failed.length > 0 && chat) {
            await client.sendMessage(chat, {
              message: `⚠️ <b>Emby 巡检异常</b>\n\n${failed.join("\n")}`,
              parseMode: "html",
            } as any);
          }
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] 健康巡检失败:`, error);
        }
      },
    },
  };

  // ── 面板设置适配器（可选） ─────────────────────────────

  panelAdapter = {
    id: PLUGIN_NAME,
    title: "Emby 管理",
    description: "配置 Emby 服务器、只读权限与巡检通知",
    category: "插件配置" as const,
    icon: "🧩",
    getSchema: () => [
      {
        key: "servers",
        label: "服务器列表",
        type: "json" as const,
        description: '形如 {"main":{"url":"http://127.0.0.1:8096","apiKey":"xxx"}}，注意包含密钥',
        default: {},
      },
      {
        key: "default",
        label: "默认服务器",
        type: "string" as const,
        placeholder: "main",
        default: "",
      },
      {
        key: "readAll",
        label: "只读命令对所有人开放",
        type: "boolean" as const,
        default: false,
      },
      {
        key: "allowedUsers",
        label: "限定使用者（TG ID 列表）",
        type: "json" as const,
        description: '形如 [123456789]，非空时只有名单内的 Telegram 用户 ID 能用本插件；留空则按管理员规则鉴权',
        default: [],
      },
      {
        key: "allowedChats",
        label: "限定聊天（聊天 ID 列表）",
        type: "json" as const,
        description: '形如 [-1001234567890]，来自这些聊天的命令视为授权；留空则不限制',
        default: [],
      },
      {
        key: "allowSudo",
        label: "白名单生效时仍允许 TeleBox 管理员",
        type: "boolean" as const,
        default: true,
      },
      {
        key: "silentReject",
        label: "未授权用户静默忽略（不回复）",
        type: "boolean" as const,
        default: true,
      },
      {
        key: "identityOverride",
        label: "手动指定操作者 TG ID",
        type: "number" as const,
        description: "消息里读不到真实发送者时使用；0 = 关闭自动推断作废",
        default: 0,
      },
      {
        key: "alertChat",
        label: "巡检通知会话",
        type: "string" as const,
        description: "填 me 或 Tg 会话/群 ID，留空则不通知",
        default: "",
      },
    ],
    getValues: async () => {
      const cfg = await this.config();
      const masked: Record<string, any> = {};
      for (const [n, s] of Object.entries(cfg.servers)) {
        masked[n] = {
          url: s.url,
          apiKey: s.apiKey ? `${s.apiKey.slice(0, 6)}***` : "",
        };
      }
      return {
        servers: masked,
        default: cfg.default,
        readAll: cfg.readAll,
        allowedUsers: cfg.allowedUsers,
        allowedChats: cfg.allowedChats || [],
        allowSudo: cfg.allowSudo,
        silentReject: cfg.silentReject,
        identityOverride: cfg.identityOverride,
        alertChat: cfg.alertChat,
      };
    },
    setValues: async (patch: Record<string, unknown>) => {
      const cfg = await this.config();
      if (patch.default !== undefined) cfg.default = String(patch.default);
      if (patch.readAll !== undefined) cfg.readAll = !!patch.readAll;
      if (patch.alertChat !== undefined) cfg.alertChat = String(patch.alertChat);
      if (patch.allowSudo !== undefined) cfg.allowSudo = !!patch.allowSudo;
      if (patch.identityOverride !== undefined) {
        cfg.identityOverride =
          this.toId(String(patch.identityOverride).replace(/[^\d]/g, "")) ?? 0;
      }
      if (patch.silentReject !== undefined) cfg.silentReject = !!patch.silentReject;
      if (patch.allowedChats !== undefined) {
        const raw = patch.allowedChats;
        const list = Array.isArray(raw)
          ? raw
          : String(raw)
              .split(/[\s,]+/)
              .filter(Boolean);
        cfg.allowedChats = [
          ...new Set(
            list
              .map((v) => Number(String(v).replace(/[^\d-]/g, "")))
              .filter((n) => Number.isFinite(n) && n !== 0),
          ),
        ];
      }
      if (patch.allowedUsers !== undefined) {
        const raw = patch.allowedUsers;
        const list = Array.isArray(raw)
          ? raw
          : String(raw)
              .split(/[\s,]+/)
              .filter(Boolean);
        cfg.allowedUsers = [
          ...new Set(
            list
              .map((v) => Number(String(v).replace(/[^\d]/g, "")))
              .filter((n) => Number.isFinite(n) && n > 0),
          ),
        ];
      }
      if (patch.servers && typeof patch.servers === "object") {
        const incoming = patch.servers as Record<string, any>;
        for (const [name, value] of Object.entries(incoming)) {
          const current = cfg.servers[name];
          const apiKey = String(value?.apiKey || "");
          // 面板回显的是掩码值，未修改则保留原密钥
          cfg.servers[name] = {
            url: String(value?.url || current?.url || "").replace(/\/+$/, ""),
            apiKey: apiKey.endsWith("***") ? current?.apiKey || "" : apiKey,
            note: value?.note,
          };
        }
        for (const name of Object.keys(cfg.servers)) {
          if (!(name in incoming)) delete cfg.servers[name];
        }
      }
      await this.saveConfig();
    },
  };

  // ── 清理 ───────────────────────────────────────────────

  async cleanup(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    this.pending.clear();
    this.sessionCache.clear();
    try {
      this.sudoDB?.close();
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 关闭 sudo 数据库失败:`, error);
    }
    this.sudoDB = null;
    this.db = null;
  }
}

export default new EmbyPlugin();
