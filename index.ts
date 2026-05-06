/* eslint-disable no-await-in-loop */
import puppeteer, { Browser } from 'puppeteer';
import * as process from 'process';
import * as fs from 'fs';
import * as path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Seoul');

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const CONFIG_PATH = process.env.CONFIG_PATH ?? path.join(__dirname, 'config.json');
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, 'data');
const REGISTRY_PATH = process.env.REGISTRY_PATH ?? path.join(DATA_DIR, 'registry.json');
const FILTERS_PATH = process.env.FILTERS_PATH ?? path.join(DATA_DIR, 'filters.json');
const NOTIFY_HISTORY_PATH =
  process.env.NOTIFY_HISTORY_PATH ?? path.join(DATA_DIR, 'notify-history.json');
const TELEGRAM_OFFSET_PATH =
  process.env.TELEGRAM_OFFSET_PATH ?? path.join(DATA_DIR, 'telegram-offset.json');

const parseChatIds = (envValue: string | undefined): string[] => {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
};

const chatIds = parseChatIds(TELEGRAM_CHAT_ID);

if (!TELEGRAM_BOT_TOKEN || chatIds.length === 0) {
  throw new Error('TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 환경변수가 필요합니다.');
}

type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const DAY_NAMES: DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES_KO = ['일', '월', '화', '수', '목', '금', '토'];

const DAY_TOKEN_TO_EN: Record<string, DayOfWeek> = {
  sun: 'sun', mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat',
  '일': 'sun', '월': 'mon', '화': 'tue', '수': 'wed', '목': 'thu', '금': 'fri', '토': 'sat',
  '일요일': 'sun', '월요일': 'mon', '화요일': 'tue', '수요일': 'wed', '목요일': 'thu', '금요일': 'fri', '토요일': 'sat'
};

function parseDayToken(s: string): DayOfWeek | null {
  return DAY_TOKEN_TO_EN[s.toLowerCase()] ?? DAY_TOKEN_TO_EN[s] ?? null;
}

type TimeWindow = {
  days: DayOfWeek[];
  from: string;
  to: string;
};

type Target = {
  name: string;
  alias: string;
  urlTemplate: string;
  daysOfWeek: DayOfWeek[];
  idxList: string[] | 'auto';
  activeWindows?: TimeWindow[];
};

type Registry = {
  lastUpdated: string;
  templates: Record<string, Record<string, string>>;
};

type DateBasedRule = {
  days?: DayOfWeek[];
  dates?: string[];
  themes?: string[];
  timeRange?: { from: string; to: string };
};

type TargetFilter = {
  rules: DateBasedRule[];
};

type FiltersFileV1 = {
  version: 1;
  filters: Record<string, string[]>;
};

type FiltersFileV2 = {
  version: 2;
  filters: Record<string, { themes?: string[]; timeRange?: { from: string; to: string } }>;
};

type FiltersFile = {
  version: 3;
  filters: Record<string, TargetFilter>;
};

type NotifyHistoryFile = {
  version: 1;
  entries: Record<string, number>;
};

type TelegramOffsetFile = {
  offset: number;
};

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

type Config = {
  checkIntervalSeconds: number;
  lookAheadDays: number;
  concurrentLimit: number;
  perRequestDelayMs: number;
  notifyCooldownMinutes: number;
  targets: Target[];
};

function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config 파일을 찾을 수 없습니다: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Config>;

  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error('config.targets 가 비어 있습니다.');
  }

  const seenAliases = new Set<string>();
  parsed.targets.forEach((target, index) => {
    if (!target.name) throw new Error(`targets[${index}].name 누락`);
    if (!target.alias) throw new Error(`targets[${index}].alias 누락 (텔레그램 명령어에서 사용)`);
    if (seenAliases.has(target.alias)) {
      throw new Error(`targets[${index}].alias 중복: ${target.alias}`);
    }
    seenAliases.add(target.alias);
    if (!target.urlTemplate) throw new Error(`targets[${index}].urlTemplate 누락`);
    if (!Array.isArray(target.daysOfWeek) || target.daysOfWeek.length === 0) {
      throw new Error(`targets[${index}].daysOfWeek 누락 또는 빈 배열`);
    }
    target.daysOfWeek.forEach((d) => {
      if (!DAY_NAMES.includes(d)) {
        throw new Error(
          `targets[${index}].daysOfWeek 에 잘못된 값: ${d} (허용: ${DAY_NAMES.join(', ')})`
        );
      }
    });
    if (target.idxList !== 'auto') {
      if (!Array.isArray(target.idxList) || target.idxList.length === 0) {
        throw new Error(`targets[${index}].idxList 누락 또는 "auto" 또는 비어있지 않은 배열`);
      }
    }
    if (target.activeWindows !== undefined) {
      if (!Array.isArray(target.activeWindows)) {
        throw new Error(`targets[${index}].activeWindows 는 배열이어야 합니다.`);
      }
      target.activeWindows.forEach((w, wi) => {
        const where = `targets[${index}].activeWindows[${wi}]`;
        if (!Array.isArray(w.days) || w.days.length === 0) {
          throw new Error(`${where}.days 누락 또는 빈 배열`);
        }
        w.days.forEach((d) => {
          if (!DAY_NAMES.includes(d)) {
            throw new Error(`${where}.days 잘못된 값: ${d} (허용: ${DAY_NAMES.join(', ')})`);
          }
        });
        if (typeof w.from !== 'string' || !HHMM_PATTERN.test(w.from)) {
          throw new Error(`${where}.from "HH:mm" 형식 아님: ${w.from}`);
        }
        if (typeof w.to !== 'string' || !HHMM_PATTERN.test(w.to)) {
          throw new Error(`${where}.to "HH:mm" 형식 아님: ${w.to}`);
        }
        if (parseHHMM(w.to) <= parseHHMM(w.from)) {
          throw new Error(
            `${where}: to(${w.to}) 는 from(${w.from}) 보다 커야 합니다. 자정을 넘는 윈도우는 둘로 분할하세요.`
          );
        }
      });
    }
  });

  return {
    checkIntervalSeconds: parsed.checkIntervalSeconds ?? 60,
    lookAheadDays: parsed.lookAheadDays ?? 7,
    concurrentLimit: parsed.concurrentLimit ?? 1,
    perRequestDelayMs: parsed.perRequestDelayMs ?? 1000,
    notifyCooldownMinutes: parsed.notifyCooldownMinutes ?? 30,
    targets: parsed.targets as Target[]
  };
}

const config = loadConfig(CONFIG_PATH);
const NOTIFY_COOLDOWN_MS = config.notifyCooldownMinutes * 60 * 1000;

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadRegistry(): Registry | null {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return null;
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
  } catch (e) {
    console.warn(`⚠️ registry 로드 실패: ${(e as Error).message}`);
    return null;
  }
}

function migrateV1ToV3(v1: FiltersFileV1): FiltersFile {
  const out: FiltersFile = { version: 3, filters: {} };
  for (const [name, substrings] of Object.entries(v1.filters)) {
    if (substrings.length > 0) {
      out.filters[name] = { rules: [{ themes: substrings }] };
    } else {
      out.filters[name] = { rules: [] };
    }
  }
  return out;
}

function migrateV2ToV3(v2: FiltersFileV2): FiltersFile {
  const out: FiltersFile = { version: 3, filters: {} };
  for (const [name, f] of Object.entries(v2.filters)) {
    const hasContent = (f.themes && f.themes.length > 0) || f.timeRange;
    if (hasContent) {
      const rule: DateBasedRule = {};
      if (f.themes && f.themes.length > 0) rule.themes = f.themes;
      if (f.timeRange) rule.timeRange = f.timeRange;
      out.filters[name] = { rules: [rule] };
    } else {
      out.filters[name] = { rules: [] };
    }
  }
  return out;
}

function loadFilters(): FiltersFile {
  try {
    if (!fs.existsSync(FILTERS_PATH)) {
      return { version: 3, filters: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf-8'));
    if (parsed.version === 3) {
      return parsed as FiltersFile;
    }
    if (parsed.version === 2) {
      console.log('🔄 filters v2 → v3 마이그레이션');
      const v3 = migrateV2ToV3(parsed as FiltersFileV2);
      saveFilters(v3);
      return v3;
    }
    if (parsed.version === 1) {
      console.log('🔄 filters v1 → v3 마이그레이션');
      const v3 = migrateV1ToV3(parsed as FiltersFileV1);
      saveFilters(v3);
      return v3;
    }
    return { version: 3, filters: {} };
  } catch (e) {
    console.warn(`⚠️ filters 로드 실패: ${(e as Error).message}`);
    return { version: 3, filters: {} };
  }
}

function saveFilters(filters: FiltersFile): void {
  ensureDataDir();
  fs.writeFileSync(FILTERS_PATH, `${JSON.stringify(filters, null, 2)}\n`, 'utf-8');
}

function loadNotifyHistory(): NotifyHistoryFile {
  try {
    if (!fs.existsSync(NOTIFY_HISTORY_PATH)) {
      return { version: 1, entries: {} };
    }
    return JSON.parse(fs.readFileSync(NOTIFY_HISTORY_PATH, 'utf-8')) as NotifyHistoryFile;
  } catch (e) {
    console.warn(`⚠️ notify-history 로드 실패: ${(e as Error).message}`);
    return { version: 1, entries: {} };
  }
}

function saveNotifyHistory(history: NotifyHistoryFile): void {
  ensureDataDir();
  fs.writeFileSync(NOTIFY_HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf-8');
}

const notifyHistory: NotifyHistoryFile = loadNotifyHistory();
console.log(
  `📂 notify-history 로드: ${Object.keys(notifyHistory.entries).length}개 쿨다운 (${NOTIFY_HISTORY_PATH})`
);

function canNotify(url: string): boolean {
  const lastSent = notifyHistory.entries[url];
  if (!lastSent) return true;
  return Date.now() - lastSent >= NOTIFY_COOLDOWN_MS;
}

function recordNotify(url: string): void {
  notifyHistory.entries[url] = Date.now();
  saveNotifyHistory(notifyHistory);
}

function cleanupExpiredCooldowns(): void {
  const now = Date.now();
  const keysToDelete: string[] = [];
  for (const [url, timestamp] of Object.entries(notifyHistory.entries)) {
    if (now - timestamp >= NOTIFY_COOLDOWN_MS) {
      keysToDelete.push(url);
    }
  }
  if (keysToDelete.length > 0) {
    keysToDelete.forEach((key) => {
      delete notifyHistory.entries[key];
    });
    saveNotifyHistory(notifyHistory);
    console.log(`🧹 만료된 알림 쿨다운 ${keysToDelete.length}개 정리`);
  }
}

function findTargetByAlias(alias: string): Target | undefined {
  return config.targets.find((t) => t.alias === alias);
}

function getThemeFromLabel(label: string): string {
  return label.split('/')[0]?.trim() ?? '';
}

function getTimeFromLabel(label: string): number | null {
  const match = label.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function matchIdxRule(label: string, rule: DateBasedRule): boolean {
  if (rule.themes && rule.themes.length > 0) {
    const theme = getThemeFromLabel(label);
    if (!rule.themes.includes(theme)) return false;
  }
  if (rule.timeRange) {
    const min = getTimeFromLabel(label);
    if (min === null) return false;
    const from = parseHHMM(rule.timeRange.from);
    const to = parseHHMM(rule.timeRange.to);
    if (min < from || min >= to) return false;
  }
  return true;
}

function matchDateRule(dayName: DayOfWeek, dateStr: string, rule: DateBasedRule): boolean {
  const hasDays = rule.days && rule.days.length > 0;
  const hasDates = rule.dates && rule.dates.length > 0;
  if (!hasDays && !hasDates) return true;
  if (hasDays && rule.days!.includes(dayName)) return true;
  if (hasDates && rule.dates!.includes(dateStr)) return true;
  return false;
}

function matchSlotForDate(
  label: string,
  dayName: DayOfWeek,
  dateStr: string,
  filter: TargetFilter | undefined
): boolean {
  if (!filter || filter.rules.length === 0) return false;
  return filter.rules.some(
    (rule) => matchIdxRule(label, rule) && matchDateRule(dayName, dateStr, rule)
  );
}

function applyLabelFilters(
  target: Target,
  idxList: string[],
  registry: Registry | null,
  filters: FiltersFile
): string[] {
  const filter = filters.filters[target.name];
  if (!filter || filter.rules.length === 0) return [];
  const slots = registry?.templates[target.urlTemplate] ?? {};
  return idxList.filter((idx) => {
    const label = slots[idx] ?? '';
    return filter.rules.some((rule) => matchIdxRule(label, rule));
  });
}

function describeRule(rule: DateBasedRule): string {
  const parts: string[] = [];
  if (rule.days && rule.days.length > 0) {
    const ko = rule.days.map((d) => DAY_NAMES_KO[DAY_NAMES.indexOf(d)]).join('/');
    parts.push(`요일=${ko}`);
  }
  if (rule.dates && rule.dates.length > 0) {
    parts.push(`날짜=${rule.dates.join(',')}`);
  }
  if (rule.themes && rule.themes.length > 0) {
    parts.push(`테마=${rule.themes.join('/')}`);
  }
  if (rule.timeRange) {
    parts.push(`시간=${rule.timeRange.from}-${rule.timeRange.to}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(전체)';
}

function describeFilter(filter: TargetFilter | undefined): string {
  if (!filter || filter.rules.length === 0) return '';
  return filter.rules.map((r, i) => `${i + 1}) ${describeRule(r)}`).join(' | ');
}

function resolveIdxList(target: Target, registry: Registry | null): string[] {
  if (target.idxList !== 'auto') {
    return target.idxList;
  }
  if (!registry) return [];
  const slots = registry.templates[target.urlTemplate];
  return slots ? Object.keys(slots) : [];
}

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getUpcomingDates = (days: number): string[] => {
  const dates: string[] = [];
  let currentDate = dayjs().tz('Asia/Seoul');
  for (let i = 0; i < days; i += 1) {
    dates.push(currentDate.format('YYYYMMDD'));
    currentDate = currentDate.add(1, 'day');
  }
  return dates;
};

function buildUrl(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (vars[key] === undefined) {
      throw new Error(`URL 템플릿 변수 '${key}' 가 정의되지 않았습니다: ${template}`);
    }
    return vars[key];
  });
}

function isTargetActiveAt(target: Target, now: dayjs.Dayjs): boolean {
  if (!target.activeWindows || target.activeWindows.length === 0) {
    return true;
  }
  const todayDayName = DAY_NAMES[now.day()];
  const currentMinute = now.hour() * 60 + now.minute();
  return target.activeWindows.some((window) => {
    if (!window.days.includes(todayDayName)) return false;
    const fromMin = parseHHMM(window.from);
    const toMin = parseHHMM(window.to);
    return currentMinute >= fromMin && currentMinute < toMin;
  });
}

function describeWindows(target: Target): string {
  if (!target.activeWindows || target.activeWindows.length === 0) {
    return '항상 활성';
  }
  return target.activeWindows
    .map((w) => `${w.days.join('/')} ${w.from}-${w.to}`)
    .join(', ');
}

type NotifyPayload = {
  targetName: string;
  formattedDate: string;
  bookingName: string;
  url: string;
};

function buildTelegramMessage({
  targetName,
  formattedDate,
  bookingName,
  url
}: NotifyPayload): string {
  const titleParts = [targetName, formattedDate, bookingName].filter(Boolean);
  const title = titleParts.join(' / ');
  return [`🔔 <b>${title}</b> 예약 가능!`, '', `<a href="${url}">예약하러 가기</a>`].join('\n');
}

async function sendTelegramTo(chatId: string, text: string): Promise<void> {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram API ${response.status}: ${errorBody}`);
  }
}

async function broadcast(text: string): Promise<void> {
  const errors: string[] = [];
  for (const chatId of chatIds) {
    try {
      await sendTelegramTo(chatId, text);
    } catch (e) {
      errors.push(`${chatId}: ${(e as Error).message}`);
    }
  }
  if (errors.length === chatIds.length) {
    throw new Error(`모든 chat_id 에 발송 실패: ${errors.join(' | ')}`);
  }
  if (errors.length > 0) {
    console.warn(`⚠️ 일부 chat_id 발송 실패: ${errors.join(' | ')}`);
  }
}

async function sendNotification(payload: NotifyPayload): Promise<void> {
  await broadcast(buildTelegramMessage(payload));
}

type SearchTask = {
  targetName: string;
  idx: string;
  date: string;
  url: string;
};

async function checkReservation(browser: Browser, task: SearchTask): Promise<void> {
  const page = await browser.newPage();

  try {
    const formattedDate = dayjs(task.date, 'YYYYMMDD').format('YYYY-MM-DD');
    console.log(`\n🔍 [${task.targetName}] idx=${task.idx}, date=${formattedDate}`);
    console.log(`   URL: ${task.url}`);

    await page.goto(task.url, { waitUntil: 'networkidle2' });
    await page.setViewport({ width: 1080, height: 1024 });

    let alertAppeared = false;
    page.on('dialog', async (dialog) => {
      alertAppeared = true;
      console.log(`   ❌ Alert 발생: ${dialog.message()}`);
      await dialog.dismiss();
    });

    const currentUrl = page.url();

    const maxReserveButtonAttempts = 5;
    let reserveButtonFound = false;
    let bookingName = '';

    for (let attempt = 1; attempt <= maxReserveButtonAttempts; attempt += 1) {
      const reserveButtons = await page.$$('a');

      for (const button of reserveButtons) {
        const buttonText = await button.evaluate((el) => el.textContent?.trim() || '');
        if (buttonText.includes('예약하기')) {
          reserveButtonFound = true;
          console.log(`   ✓ "예약하기" 버튼 발견 (시도 ${attempt}/${maxReserveButtonAttempts})`);

          await button.click();
          console.log('   ✓ "예약하기" 버튼 클릭');

          bookingName = await page.evaluate(() => {
            const detailElement = document.querySelector('.booking_content_detail > div');
            return detailElement ? detailElement.textContent?.trim() || '' : '';
          });

          break;
        }
      }

      if (reserveButtonFound) break;

      if (attempt < maxReserveButtonAttempts) {
        console.log(
          `   ⏳ "예약하기" 버튼을 찾을 수 없음, 새로고침 후 재시도... (${attempt}/${maxReserveButtonAttempts})`
        );
        await page.reload({ waitUntil: 'networkidle2' });
        await delay(500);
      }
    }

    if (!reserveButtonFound) {
      console.log('   ❌ "예약하기" 버튼을 찾을 수 없음 (최종 실패)\n');
      return;
    }

    await delay(500);

    const maxNonMemberButtonAttempts = 5;
    let nonMemberButtonClicked = false;

    for (let attempt = 1; attempt <= maxNonMemberButtonAttempts; attempt += 1) {
      nonMemberButtonClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('a, button'));
        const button = buttons.find((btn) => {
          const text = btn.textContent?.trim() || '';
          return text.includes('비회원') && text.includes('예약');
        });
        if (button && button instanceof HTMLElement) {
          button.click();
          return true;
        }
        return false;
      });

      if (nonMemberButtonClicked) {
        console.log(
          `   ✓ "비회원 예약" 버튼 클릭 (시도 ${attempt}/${maxNonMemberButtonAttempts})`
        );
        break;
      }

      if (attempt < maxNonMemberButtonAttempts) {
        console.log(
          `   ⏳ "비회원 예약" 버튼을 찾을 수 없음, 재시도... (${attempt}/${maxNonMemberButtonAttempts})`
        );
        await delay(500);
      }
    }

    if (!nonMemberButtonClicked) {
      console.log('   ❌ "비회원 예약" 버튼을 찾을 수 없음 (최종 실패)\n');
      return;
    }

    await delay(2000);

    if (alertAppeared) {
      console.log('   ❌ 예약 불가 (alert 발생)\n');
      return;
    }

    const newUrl = page.url();
    const redirected = currentUrl !== newUrl;

    if (!redirected) {
      console.log('   ⚠️ 리다이렉트가 발생하지 않음 - 상태 불명확\n');
      return;
    }

    console.log('   ✅ 페이지 리다이렉트 감지 - 예약 가능!');
    console.log(`   📝 예약 이름: ${bookingName || '(이름 없음)'}`);

    if (!canNotify(task.url)) {
      const lastSent = notifyHistory.entries[task.url];
      const minutesAgo = lastSent ? Math.floor((Date.now() - lastSent) / 1000 / 60) : 0;
      console.log(
        `   ⏭️ 알림 건너뜀 (${minutesAgo}분 전 발송, ${config.notifyCooldownMinutes}분 후 재발송 가능)\n`
      );
      return;
    }

    await sendNotification({
      targetName: task.targetName,
      formattedDate,
      bookingName,
      url: task.url
    });
    recordNotify(task.url);
    console.log('   ✅ 알림 발송 완료\n');
  } catch (e) {
    console.log(`   ❌ 오류 발생:`, e);
  } finally {
    await page.close();
    await delay(config.perRequestDelayMs);
  }
}

function buildSearchTasks(now: dayjs.Dayjs): SearchTask[] {
  const dates = getUpcomingDates(config.lookAheadDays);
  const tasks: SearchTask[] = [];
  const registry = loadRegistry();
  const filters = loadFilters();

  for (const target of config.targets) {
    if (!isTargetActiveAt(target, now)) {
      console.log(
        `⏸️  [${target.name}] 비활성 시간대 - 스킵 (활성: ${describeWindows(target)})`
      );
    } else {
      const allIdxes = resolveIdxList(target, registry);
      const filter = filters.filters[target.name];
      const desc = describeFilter(filter);
      const filterDesc = desc ? ` [필터: ${desc}]` : '';
      const slots = registry?.templates[target.urlTemplate] ?? {};

      if (!filter || filter.rules.length === 0) {
        console.log(`⏸️  [${target.name}] 비활성 (룰 없음 - /set 으로 룰 추가)`);
      } else if (allIdxes.length === 0) {
        const reason =
          target.idxList === 'auto'
            ? 'idxList="auto" 인데 registry 비었거나 매칭 없음'
            : 'idxList 비었음';
        console.log(`⚠️  [${target.name}]${filterDesc} 검색 idx 없음 - 스킵 (${reason})`);
      } else {
        const taskCountBefore = tasks.length;
        const allowedDays = new Set(target.daysOfWeek);
        for (const date of dates) {
          const dow = dayjs(date, 'YYYYMMDD').day();
          const dayName = DAY_NAMES[dow];
          const dateStr = dayjs(date, 'YYYYMMDD').format('YYYY-MM-DD');
          if (allowedDays.has(dayName)) {
            for (const idx of allIdxes) {
              const label = slots[idx] ?? '';
              if (matchSlotForDate(label, dayName, dateStr, filter)) {
                tasks.push({
                  targetName: target.name,
                  idx,
                  date,
                  url: buildUrl(target.urlTemplate, { idx, date })
                });
              }
            }
          }
        }
        const added = tasks.length - taskCountBefore;
        console.log(`▶️  [${target.name}]${filterDesc} ${added}개 작업 (전체 idx ${allIdxes.length}개 중)`);
      }
    }
  }

  return tasks;
}

function summarizeTasks(tasks: SearchTask[]): void {
  const byTargetDate = new Map<string, number>();
  for (const t of tasks) {
    const key = `${t.targetName}|${t.date}`;
    byTargetDate.set(key, (byTargetDate.get(key) ?? 0) + 1);
  }
  const sorted = Array.from(byTargetDate.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, count] of sorted) {
    const [name, date] = key.split('|');
    const dow = dayjs(date, 'YYYYMMDD').day();
    const formatted = dayjs(date, 'YYYYMMDD').format('YYYY-MM-DD');
    console.log(`   - ${name} / ${formatted}(${DAY_NAMES_KO[dow]}): ${count}개 idx`);
  }
}

async function runCrawlingCycle(cycleNumber: number): Promise<void> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(
    `🔄 사이클 #${cycleNumber} 시작 - ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm:ss')}`
  );
  console.log(`${'='.repeat(80)}\n`);

  cleanupExpiredCooldowns();

  const now = dayjs().tz('Asia/Seoul');
  const searchTasks = buildSearchTasks(now);
  console.log(`🔍 총 ${searchTasks.length}개의 검색 작업`);
  summarizeTasks(searchTasks);
  console.log(`\n⏱️  ${config.concurrentLimit}개씩 병렬로 처리합니다...\n`);

  if (searchTasks.length === 0) {
    console.log('⚠️  검색 대상이 없습니다.\n');
    return;
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    for (let i = 0; i < searchTasks.length; i += config.concurrentLimit) {
      const batch = searchTasks.slice(i, i + config.concurrentLimit);
      const batchPromises = batch.map((task, index) => {
        const globalIndex = i + index + 1;
        console.log(`\n[${globalIndex}/${searchTasks.length}] 탐색 중...`);
        return checkReservation(browser, task);
      });
      await Promise.all(batchPromises);
    }

    console.log(`\n✅ 사이클 #${cycleNumber} 완료!`);
  } finally {
    await browser.close();
  }
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
};

function loadTelegramOffset(): number {
  try {
    if (!fs.existsSync(TELEGRAM_OFFSET_PATH)) return 0;
    return (JSON.parse(fs.readFileSync(TELEGRAM_OFFSET_PATH, 'utf-8')) as TelegramOffsetFile)
      .offset;
  } catch {
    return 0;
  }
}

function saveTelegramOffset(offset: number): void {
  ensureDataDir();
  fs.writeFileSync(TELEGRAM_OFFSET_PATH, `${JSON.stringify({ offset })}\n`, 'utf-8');
}

async function getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=${timeoutSec}&offset=${offset}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`getUpdates ${response.status}: ${body}`);
  }
  const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
  return data.result ?? [];
}

function buildHelpMessage(): string {
  const aliases = config.targets.map((t) => `  • <code>${t.alias}</code> = ${t.name}`).join('\n');
  return [
    '🤖 <b>dpsnnn-alert 명령어</b>',
    '',
    '/help - 이 도움말',
    '/status - 현재 봇 상태',
    '/list - 발견된 슬롯 + 현재 룰',
    '/themes - 발견된 모든 슬롯 목록',
    '/set &lt;alias&gt; [요일|날짜] [테마] [HH:MM-HH:MM] - 룰 추가 (누적)',
    '/clear &lt;alias&gt; [번호] - 모든 룰 해제 또는 특정 번호 제거',
    '',
    '<b>타겟 alias:</b>',
    aliases,
    '',
    '<b>토큰 자동 인식</b>',
    '• 요일: <code>월/화/수/목/금/토/일</code> 또는 <code>mon/tue/...</code> 또는 <code>월요일/...</code>',
    '• 날짜: <code>2026-05-12</code> (YYYY-MM-DD)',
    '• 시간: <code>19:00-22:00</code> (HH:MM-HH:MM)',
    '• 그 외: 테마 (예: <code>상자</code>, <code>행복</code>)',
    '',
    '<b>예시</b>',
    '<code>/set g 월 19:00-22:00</code> → 월요일 + 19~22시',
    '<code>/set g 화,금 상자 19:00-22:00</code> → 화/금 + 상자 + 19~22시',
    '<code>/set g 토,일 14:00-18:00</code> → 주말 + 14~18시',
    '<code>/set g 2026-05-12 19:00-22:00</code> → 특정 날짜 + 19~22시',
    '<code>/set g 상자</code> → 모든 날짜 상자 테마',
    '',
    '<b>룰 누적 + 개별 삭제</b>',
    '• <code>/set</code> 매번 호출 시 룰이 추가됨 (덮어쓰지 않음)',
    '• 어느 룰이라도 매칭하면 통과 (룰 끼리는 OR)',
    '• 한 룰 안의 조건들은 AND (예: 월요일 + 상자)',
    '• <code>/clear g 2</code> → 2번 룰만 제거 (번호는 <code>/list</code> 에서 확인)',
    '• <code>/clear g</code> → 모든 룰 해제',
    '',
    '<b>참고</b>',
    '• <b>룰 0개 = 비활성</b> (알림 안 옴). <code>/set</code> 으로 룰 추가해야 모니터링 시작',
    '• 시간 범위는 from 포함, to 미포함 (19:00-22:00 → 21:30 ✓ / 22:00 ✗)',
    '• 룰 안에 요일/날짜 둘 다 있으면 OR'
  ].join('\n');
}

function buildStatusMessage(): string {
  const filters = loadFilters();
  const registry = loadRegistry();
  const now = dayjs().tz('Asia/Seoul');
  const lines: string[] = ['📊 <b>봇 상태</b>', ''];

  for (const target of config.targets) {
    const allIdx = resolveIdxList(target, registry);
    const matched = applyLabelFilters(target, allIdx, registry, filters);
    const filter = filters.filters[target.name];
    const ruleCount = filter?.rules.length ?? 0;
    const active = isTargetActiveAt(target, now);
    lines.push(`<b>[${target.alias}] ${target.name}</b>`);
    lines.push(`  봇 활성 시간대: ${describeWindows(target)}`);
    lines.push(`  현재 활성: ${active ? '✅ 예' : '⏸️ 아니오'}`);
    if (ruleCount === 0) {
      lines.push('  룰: <b>없음 — 비활성</b> (<code>/set</code> 으로 룰 추가)');
    } else {
      lines.push(`  룰 ${ruleCount}개:`);
      filter!.rules.forEach((r, i) => {
        lines.push(`    ${i + 1}) ${describeRule(r)}`);
      });
    }
    lines.push(`  idx 매칭: ${matched.length}개 (전체 ${allIdx.length}개)`);
    lines.push('');
  }

  lines.push(`사이클 간격: ${config.checkIntervalSeconds}초`);
  lines.push(`알림 쿨다운: ${config.notifyCooldownMinutes}분`);
  lines.push(`registry 갱신: ${registry?.lastUpdated ?? '(없음)'}`);
  return lines.join('\n');
}

function buildListMessage(): string {
  const filters = loadFilters();
  const registry = loadRegistry();
  const lines: string[] = ['📋 <b>모니터링 슬롯</b>', ''];

  for (const target of config.targets) {
    const allIdx = resolveIdxList(target, registry);
    const matched = new Set(applyLabelFilters(target, allIdx, registry, filters));
    const filter = filters.filters[target.name];
    const ruleCount = filter?.rules.length ?? 0;
    const slots = registry?.templates[target.urlTemplate] ?? {};

    lines.push(
      `<b>[${target.alias}] ${target.name}</b> ${ruleCount === 0 ? '(비활성 — 룰 없음)' : `(${ruleCount}개 룰)`}`
    );
    if (ruleCount > 0) {
      filter!.rules.forEach((r, i) => {
        lines.push(`  ${i + 1}) ${describeRule(r)}`);
      });
    }
    if (allIdx.length === 0) {
      lines.push('  (registry 비어있음 — 디스커버리 대기)');
    } else {
      for (const idx of allIdx) {
        const label = slots[idx] ?? '(라벨 없음)';
        const mark = matched.has(idx) ? '✅' : '⏭️';
        lines.push(`  ${mark} ${label} <code>idx=${idx}</code>`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildThemesMessage(): string {
  const registry = loadRegistry();
  if (!registry) return '⚠️ registry 가 아직 비어있습니다. 디스커버리 컨테이너 결과를 기다려주세요.';

  const lines: string[] = ['📚 <b>발견된 모든 슬롯</b>', ''];
  for (const target of config.targets) {
    const slots = registry.templates[target.urlTemplate] ?? {};
    const themeMap = new Map<string, string[]>();
    for (const [idx, label] of Object.entries(slots)) {
      const theme = label.split('/')[0]?.trim() ?? label;
      const list = themeMap.get(theme) ?? [];
      list.push(`${label} (idx=${idx})`);
      themeMap.set(theme, list);
    }
    lines.push(`<b>[${target.alias}] ${target.name}</b>`);
    if (themeMap.size === 0) {
      lines.push('  (없음)');
    } else {
      for (const [theme, items] of themeMap) {
        lines.push(`  <b>${theme}</b> (${items.length}개)`);
        items.forEach((it) => lines.push(`    • ${it}`));
      }
    }
    lines.push('');
  }
  lines.push('<b>추천 substring</b>: 테마 이름만 (예: <code>상자</code>) 또는 시간 포함 (예: <code>행복 / 19</code>)');
  return lines.join('\n');
}

const TIME_RANGE_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function normalizeHHMM(s: string): string {
  const [h, m] = s.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

type ParsedSetArgs = {
  rule?: DateBasedRule;
  error?: string;
};

function parseSetArgs(args: string[]): ParsedSetArgs {
  const text = args.join(' ').trim();
  if (text.length === 0) return { error: 'empty' };

  const tokens = text.split(/[,\s]+/).filter((t) => t.length > 0);
  const days: DayOfWeek[] = [];
  const dates: string[] = [];
  const themes: string[] = [];
  let timeRange: { from: string; to: string } | undefined;

  for (const tok of tokens) {
    const timeMatch = tok.match(TIME_RANGE_PATTERN);
    if (timeMatch) {
      if (timeRange) {
        return { error: '시간 범위는 하나만 지정할 수 있습니다.' };
      }
      const from = normalizeHHMM(`${timeMatch[1]}:${timeMatch[2]}`);
      const to = normalizeHHMM(`${timeMatch[3]}:${timeMatch[4]}`);
      if (parseHHMM(from) >= parseHHMM(to)) {
        return { error: `시간 범위 to(${to}) 가 from(${from}) 보다 커야 합니다.` };
      }
      timeRange = { from, to };
    } else if (DATE_PATTERN.test(tok)) {
      if (!dayjs(tok, 'YYYY-MM-DD', true).isValid()) {
        return { error: `잘못된 날짜: ${tok} (YYYY-MM-DD 형식 + 유효한 날짜)` };
      }
      dates.push(tok);
    } else {
      const day = parseDayToken(tok);
      if (day) {
        days.push(day);
      } else {
        themes.push(tok);
      }
    }
  }

  const rule: DateBasedRule = {};
  if (days.length > 0) rule.days = Array.from(new Set(days));
  if (dates.length > 0) rule.dates = Array.from(new Set(dates));
  if (themes.length > 0) rule.themes = Array.from(new Set(themes));
  if (timeRange) rule.timeRange = timeRange;

  if (Object.keys(rule).length === 0) {
    return { error: '아무 조건도 인식하지 못했습니다.' };
  }
  return { rule };
}

function handleSet(args: string[]): string {
  if (args.length === 0) {
    return '❌ 사용법: <code>/set &lt;alias&gt; [요일/날짜] [테마] [HH:MM-HH:MM]</code>\n예: <code>/set g 월,화 상자 19:00-22:00</code>';
  }
  const alias = args[0];
  const target = findTargetByAlias(alias);
  if (!target) {
    const available = config.targets.map((t) => t.alias).join(', ');
    return `❌ 알 수 없는 alias: <code>${alias}</code> (가능: ${available})`;
  }

  const parsed = parseSetArgs(args.slice(1));
  if (parsed.error === 'empty') {
    return `❌ 조건이 비어있습니다. 예: <code>/set ${alias} 월 19:00-22:00</code>`;
  }
  if (parsed.error || !parsed.rule) {
    return `❌ ${parsed.error}`;
  }

  const filters = loadFilters();
  if (!filters.filters[target.name]) {
    filters.filters[target.name] = { rules: [] };
  }
  filters.filters[target.name].rules.push(parsed.rule);
  saveFilters(filters);

  const filter = filters.filters[target.name];
  const registry = loadRegistry();
  const allIdx = resolveIdxList(target, registry);
  const matched = applyLabelFilters(target, allIdx, registry, filters);
  const slots = registry?.templates[target.urlTemplate] ?? {};
  const sample = matched
    .slice(0, 6)
    .map((idx) => slots[idx] ?? `idx=${idx}`)
    .join(', ');
  const overflow = matched.length > 6 ? ` (외 ${matched.length - 6}개)` : '';

  return [
    `✅ <b>${target.name}</b> 룰 추가 (총 ${filter.rules.length}개)`,
    `추가: ${describeRule(parsed.rule)}`,
    `idx 매칭: ${matched.length}개 / 전체 ${allIdx.length}개 (날짜 무관 통계)`,
    matched.length > 0 ? `예: ${sample}${overflow}` : '⚠️ idx 매칭 0개 - 룰을 다시 확인하세요',
    '다음 사이클부터 적용됩니다. <code>/list</code> 로 전체 룰 확인.'
  ].join('\n');
}

function handleClear(args: string[]): string {
  if (args.length === 0) {
    return '❌ 사용법: <code>/clear &lt;alias&gt; [번호]</code>\n예: <code>/clear g</code> (전체) / <code>/clear g 2</code> (2번 룰만)';
  }
  const alias = args[0];
  const target = findTargetByAlias(alias);
  if (!target) {
    const available = config.targets.map((t) => t.alias).join(', ');
    return `❌ 알 수 없는 alias: <code>${alias}</code> (가능: ${available})`;
  }

  const filters = loadFilters();
  const filter = filters.filters[target.name];

  if (!filter || filter.rules.length === 0) {
    return `ℹ️ <b>${target.name}</b> 에 등록된 룰이 없습니다.`;
  }

  if (args.length === 1) {
    delete filters.filters[target.name];
    saveFilters(filters);
    return `✅ <b>${target.name}</b> 모든 룰 해제 (전체 모드).\n다음 사이클부터 적용됩니다.`;
  }

  const idxArg = args[1];
  const ruleNumber = parseInt(idxArg, 10);
  if (Number.isNaN(ruleNumber) || ruleNumber < 1 || ruleNumber > filter.rules.length) {
    return `❌ 잘못된 번호: <code>${idxArg}</code> (1~${filter.rules.length} 범위)`;
  }

  const removed = filter.rules.splice(ruleNumber - 1, 1)[0];
  if (filter.rules.length === 0) {
    delete filters.filters[target.name];
  }
  saveFilters(filters);

  const remainingDesc =
    filter.rules.length === 0
      ? '남은 룰 없음 (전체 모드)'
      : filter.rules.map((r, i) => `  ${i + 1}) ${describeRule(r)}`).join('\n');

  return [
    `✅ <b>${target.name}</b> ${ruleNumber}번 룰 제거`,
    `제거: ${describeRule(removed)}`,
    `남은 룰 ${filter.rules.length}개:`,
    remainingDesc,
    '다음 사이클부터 적용됩니다.'
  ].join('\n');
}

async function handleCommand(chatId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head.replace(/@\w+$/, '').toLowerCase();

  let reply: string | null = null;
  try {
    if (command === '/help' || command === '/start') {
      reply = buildHelpMessage();
    } else if (command === '/status') {
      reply = buildStatusMessage();
    } else if (command === '/list') {
      reply = buildListMessage();
    } else if (command === '/themes') {
      reply = buildThemesMessage();
    } else if (command === '/set') {
      reply = handleSet(rest);
    } else if (command === '/clear') {
      reply = handleClear(rest);
    } else if (command.startsWith('/')) {
      reply = `❓ 알 수 없는 명령: <code>${command}</code>\n<code>/help</code> 로 명령어를 확인하세요.`;
    }
  } catch (e) {
    reply = `⚠️ 처리 중 오류: ${(e as Error).message}`;
  }

  if (reply !== null) {
    try {
      await sendTelegramTo(chatId, reply);
    } catch (e) {
      console.warn(`텔레그램 응답 발송 실패: ${(e as Error).message}`);
    }
  }
}

async function telegramPollingLoop(): Promise<void> {
  let offset = loadTelegramOffset();
  console.log(`📡 텔레그램 polling 시작 (offset=${offset})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await getUpdates(offset, 30);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        saveTelegramOffset(offset);

        const msg = update.message;
        if (msg && msg.text) {
          const chatIdStr = String(msg.chat.id);
          if (chatIds.includes(chatIdStr)) {
            console.log(`📨 [${chatIdStr}] ${msg.text}`);
            await handleCommand(chatIdStr, msg.text);
          } else {
            console.log(`🚫 비인증 chat_id ${chatIdStr} 메시지 무시: ${msg.text.slice(0, 50)}`);
          }
        }
      }
    } catch (e) {
      console.warn(`polling 오류: ${(e as Error).message}`);
      await delay(5000);
    }
  }
}

async function cycleLoop(): Promise<void> {
  let cycleNumber = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      console.log(`\n⏰ ${dayjs().tz('Asia/Seoul').format('HH:mm:ss')} 사이클 시작`);
      await runCrawlingCycle(cycleNumber);
      console.log(`\n⏰ ${dayjs().tz('Asia/Seoul').format('HH:mm:ss')} 사이클 종료`);
      cycleNumber += 1;
    } catch (e) {
      console.error(`\n❌ 사이클 #${cycleNumber}에서 오류 발생:`, e);
    }

    if (config.checkIntervalSeconds > 0) {
      console.log(`\n💤 다음 사이클까지 ${config.checkIntervalSeconds}초 대기...\n`);
      await delay(config.checkIntervalSeconds * 1000);
    }
  }
}

(async () => {
  console.log(`🚀 dpsnnn-alert 시작`);
  console.log(`📁 설정 파일: ${CONFIG_PATH}`);
  console.log(`💾 데이터 디렉토리: ${DATA_DIR}`);
  console.log(`🎯 타겟 ${config.targets.length}개:`);
  for (const t of config.targets) {
    const idxDesc = t.idxList === 'auto' ? 'idx auto' : `idx ${t.idxList.length}개`;
    console.log(
      `   - [${t.alias}] ${t.name} (요일: ${t.daysOfWeek.join(',')}, ${idxDesc}, 활성: ${describeWindows(t)})`
    );
  }
  console.log(`📱 텔레그램 수신자 ${chatIds.length}명에게 알림을 발송합니다.`);
  console.log(
    `🔁 사이클 간격 ${config.checkIntervalSeconds}초. 종료하려면 Ctrl+C 를 누르세요.\n`
  );

  ensureDataDir();

  const onSignal = (signal: string) => {
    console.log(`\n📴 ${signal} 수신 - 즉시 종료합니다.`);
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await Promise.all([cycleLoop(), telegramPollingLoop()]);
})();
