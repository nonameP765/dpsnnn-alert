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
const REGISTRY_PATH = process.env.REGISTRY_PATH ?? path.join(__dirname, 'data', 'registry.json');
const SCAN_IDX_MAX = parseInt(process.env.SCAN_IDX_MAX ?? '100', 10);
const SCAN_CONCURRENCY = parseInt(process.env.SCAN_CONCURRENCY ?? '1', 10);
const SCAN_PER_REQUEST_DELAY_MS = parseInt(process.env.SCAN_PER_REQUEST_DELAY_MS ?? '500', 10);
const DISCOVER_HOUR = parseInt(process.env.DISCOVER_HOUR ?? '23', 10);
const DISCOVER_MINUTE = parseInt(process.env.DISCOVER_MINUTE ?? '50', 10);
const RUN_ON_START = process.env.DISCOVER_RUN_ON_START !== 'false';

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

type RawTarget = {
  name?: string;
  urlTemplate?: string;
};

type Registry = {
  lastUpdated: string;
  templates: Record<string, Record<string, string>>;
};

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function getUniqueTemplates(): { name: string; urlTemplate: string }[] {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const targets = (raw.targets ?? []) as RawTarget[];
  const seen = new Map<string, string>();
  for (const t of targets) {
    if (t.urlTemplate && t.name && !seen.has(t.urlTemplate)) {
      seen.set(t.urlTemplate, t.name);
    }
  }
  return Array.from(seen.entries()).map(([urlTemplate, name]) => ({ name, urlTemplate }));
}

async function probeIdx(
  browser: Browser,
  urlTemplate: string,
  idx: string,
  date: string
): Promise<string | null> {
  const url = urlTemplate.replace(/\{idx\}/g, idx).replace(/\{date\}/g, date);
  const page = await browser.newPage();

  try {
    page.on('dialog', (dialog) => {
      dialog.dismiss().catch(() => undefined);
    });

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    if (!response || response.status() >= 400) {
      return null;
    }

    const bookingName = await page.evaluate(() => {
      const el = document.querySelector('.booking_content_detail > div');
      return el?.textContent?.trim() ?? '';
    });

    return bookingName.length > 0 ? bookingName : null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function discoverTemplate(
  browser: Browser,
  name: string,
  urlTemplate: string,
  date: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  console.log(`\n🔍 [${name}] 스캔 시작 (idx 1~${SCAN_IDX_MAX}, 동시성 ${SCAN_CONCURRENCY})`);

  for (let start = 1; start <= SCAN_IDX_MAX; start += SCAN_CONCURRENCY) {
    const batchStart = start;
    const batchEnd = Math.min(start + SCAN_CONCURRENCY - 1, SCAN_IDX_MAX);
    const batchPromises: Promise<void>[] = [];

    for (let i = batchStart; i <= batchEnd; i += 1) {
      const idx = String(i);
      batchPromises.push(
        probeIdx(browser, urlTemplate, idx, date).then((label) => {
          if (label) {
            result[idx] = label;
            console.log(`   ✓ idx=${idx.padStart(3)}: ${label}`);
          }
        })
      );
    }

    await Promise.all(batchPromises);
    if (SCAN_PER_REQUEST_DELAY_MS > 0) {
      await delay(SCAN_PER_REQUEST_DELAY_MS);
    }
  }

  console.log(`✅ [${name}] ${Object.keys(result).length}개 발견`);
  return result;
}

function loadPreviousRegistry(): Registry | null {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return null;
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
  } catch (e) {
    console.warn(`⚠️ 이전 registry 로드 실패: ${(e as Error).message}`);
    return null;
  }
}

function saveRegistry(registry: Registry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

type SlotChange = {
  templateName: string;
  idx: string;
  label: string;
  oldLabel?: string;
};

type Diff = {
  added: SlotChange[];
  removed: SlotChange[];
  renamed: SlotChange[];
};

function computeDiff(
  templates: { name: string; urlTemplate: string }[],
  previous: Registry | null,
  next: Registry
): Diff {
  const diff: Diff = { added: [], removed: [], renamed: [] };

  for (const { name, urlTemplate } of templates) {
    const nextSlots = next.templates[urlTemplate] ?? {};
    const prevSlots = previous?.templates[urlTemplate] ?? {};

    for (const [idx, label] of Object.entries(nextSlots)) {
      if (!(idx in prevSlots)) {
        diff.added.push({ templateName: name, idx, label });
      } else if (prevSlots[idx] !== label) {
        diff.renamed.push({ templateName: name, idx, label, oldLabel: prevSlots[idx] });
      }
    }

    for (const [idx, label] of Object.entries(prevSlots)) {
      if (!(idx in nextSlots)) {
        diff.removed.push({ templateName: name, idx, label });
      }
    }
  }

  return diff;
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
      disable_web_page_preview: true
    })
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram API ${response.status}: ${errorBody}`);
  }
}

function formatDiffMessage(diff: Diff): string {
  const lines: string[] = [];
  lines.push('🆕 <b>단편선 슬롯 변경 감지</b>');
  lines.push('');

  if (diff.added.length > 0) {
    lines.push(`<b>➕ 신규 (${diff.added.length})</b>`);
    const grouped = groupByTemplate(diff.added);
    for (const [name, items] of grouped) {
      lines.push(`  <i>${name}</i>`);
      items.forEach((s) => lines.push(`    • idx=${s.idx} → ${s.label}`));
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push(`<b>➖ 사라짐 (${diff.removed.length})</b>`);
    const grouped = groupByTemplate(diff.removed);
    for (const [name, items] of grouped) {
      lines.push(`  <i>${name}</i>`);
      items.forEach((s) => lines.push(`    • idx=${s.idx} (${s.label})`));
    }
    lines.push('');
  }

  if (diff.renamed.length > 0) {
    lines.push(`<b>🔄 변경 (${diff.renamed.length})</b>`);
    const grouped = groupByTemplate(diff.renamed);
    for (const [name, items] of grouped) {
      lines.push(`  <i>${name}</i>`);
      items.forEach((s) => lines.push(`    • idx=${s.idx}: ${s.oldLabel} → ${s.label}`));
    }
    lines.push('');
  }

  lines.push('config.json 의 idxList 를 검토해 주세요.');
  return lines.join('\n');
}

function groupByTemplate(slots: SlotChange[]): Map<string, SlotChange[]> {
  const map = new Map<string, SlotChange[]>();
  for (const s of slots) {
    const list = map.get(s.templateName) ?? [];
    list.push(s);
    map.set(s.templateName, list);
  }
  return map;
}

async function notifyDiff(diff: Diff): Promise<void> {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.renamed.length === 0) {
    console.log('변경 사항 없음 - 알림 스킵');
    return;
  }
  const text = formatDiffMessage(diff);
  console.log(`📱 텔레그램 알림 전송 (added=${diff.added.length}, removed=${diff.removed.length}, renamed=${diff.renamed.length})`);

  const errors: string[] = [];
  for (const chatId of chatIds) {
    try {
      await sendTelegramTo(chatId, text);
    } catch (e) {
      errors.push(`${chatId}: ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) {
    console.warn(`⚠️ 일부 chat_id 발송 실패: ${errors.join(' | ')}`);
  }
}

async function discoverOnce(): Promise<void> {
  const startedAt = dayjs().tz('Asia/Seoul');
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔄 디스커버리 시작 - ${startedAt.format('YYYY-MM-DD HH:mm:ss')}`);
  console.log(`${'='.repeat(80)}`);

  const templates = getUniqueTemplates();
  if (templates.length === 0) {
    console.log('⚠️ config 에 urlTemplate 이 없습니다.');
    return;
  }

  const probeDate = dayjs().tz('Asia/Seoul').add(7, 'day').format('YYYYMMDD');
  console.log(`프로브 날짜: ${probeDate} (오늘+7일)`);

  const previous = loadPreviousRegistry();
  if (previous) {
    console.log(`이전 registry: ${previous.lastUpdated}`);
  } else {
    console.log('이전 registry 없음 (최초 실행)');
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const next: Registry = {
      lastUpdated: startedAt.toISOString(),
      templates: {}
    };

    for (const { name, urlTemplate } of templates) {
      next.templates[urlTemplate] = await discoverTemplate(browser, name, urlTemplate, probeDate);
    }

    const diff = computeDiff(templates, previous, next);
    saveRegistry(next);
    console.log(`\n💾 registry.json 저장: ${REGISTRY_PATH}`);

    if (previous) {
      await notifyDiff(diff);
    } else {
      console.log('최초 실행 - 신규 알림은 다음 회차부터 발송됩니다.');
    }
  } finally {
    await browser.close();
  }

  const finishedAt = dayjs().tz('Asia/Seoul');
  console.log(`✅ 디스커버리 완료 (${finishedAt.diff(startedAt, 'second')}초 소요)\n`);
}

async function main(): Promise<void> {
  console.log('🚀 dpsnnn-discover 시작');
  console.log(`📁 config: ${CONFIG_PATH}`);
  console.log(`💾 registry: ${REGISTRY_PATH}`);
  console.log(
    `🔍 스캔 범위: idx 1~${SCAN_IDX_MAX} (동시성 ${SCAN_CONCURRENCY}, 요청 간 ${SCAN_PER_REQUEST_DELAY_MS}ms)`
  );
  console.log(`⏰ 스케줄: 매일 ${String(DISCOVER_HOUR).padStart(2, '0')}:${String(DISCOVER_MINUTE).padStart(2, '0')} KST`);

  const onSignal = (signal: string) => {
    console.log(`\n📴 ${signal} 수신 - 즉시 종료합니다.`);
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  if (RUN_ON_START) {
    try {
      await discoverOnce();
    } catch (e) {
      console.error('❌ 디스커버리 오류:', e);
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = dayjs().tz('Asia/Seoul');
    let target = now
      .hour(DISCOVER_HOUR)
      .minute(DISCOVER_MINUTE)
      .second(0)
      .millisecond(0);
    if (target.valueOf() <= now.valueOf()) {
      target = target.add(1, 'day');
    }
    const sleepMs = target.diff(now);
    console.log(
      `\n💤 다음 디스커버리: ${target.format('YYYY-MM-DD HH:mm')} (${Math.floor(sleepMs / 60000)}분 후)`
    );
    await delay(sleepMs);

    try {
      await discoverOnce();
    } catch (e) {
      console.error('❌ 디스커버리 오류:', e);
    }
  }
}

main();
