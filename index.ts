/* eslint-disable no-await-in-loop */
import puppeteer, { Browser } from 'puppeteer';
import nodemailer from 'nodemailer';
import * as process from 'process';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

// dayjs 플러그인 설정 및 한국 시간대 기본 설정
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Seoul');

const DPSNNN_G_URL = 'https://www.dpsnnn.com/reserve_g';
// const DPSNNN_SS_URL = 'https://dpsnnn-s.imweb.me/reserve_ss';

// 개발 모드 확인
const isDevelopment = process.env.NODE_ENV === 'development';

// 개발 모드일 때 기본값 사용
const {
  SENDER_GMAIL_USER,
  SENDER_GMAIL_PASSWORD,
  TARGET_GMAIL_USER,
  // G_SEARCH_LIST = isDevelopment ? '25,5,6,7,8,9,10,11,12,36,35,34,33,32,31,30,29,28' : undefined
  G_SEARCH_LIST = isDevelopment ? '25,5,6,7,8,9,10,11,12,36,35,34,33,32,31,30,29,28' : undefined
  // SS_SEARCH_LIST = isDevelopment ? '' : undefined
} = process.env;

type SearchItem = { idx: string };

// 환경변수에서 검색 리스트 파싱 (쉼표로 구분)
const parseSearchList = (envValue: string | undefined): SearchItem[] => {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((idx) => idx.trim())
    .filter((idx) => idx.length > 0)
    .map((idx) => ({ idx }));
};

const gSearchList: SearchItem[] = parseSearchList(G_SEARCH_LIST);
// const ssSearchList: SearchItem[] = parseSearchList(SS_SEARCH_LIST);

const parseTargetEmailList = (envValue: string | undefined): string[] => {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
};

const targetEmailList = parseTargetEmailList(TARGET_GMAIL_USER);

if (
  (!SENDER_GMAIL_USER || !SENDER_GMAIL_PASSWORD || targetEmailList.length === 0) &&
  !isDevelopment
) {
  throw new Error('SENDER_GMAIL_USER, SENDER_GMAIL_PASSWORD, TARGET_GMAIL_USER must be set');
}

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// 병렬 실행 개수 설정 (1 = 순차 실행, 2 이상 = 병렬 실행)
const CONCURRENT_LIMIT = 7;

// 메일 발송 기록 저장 (URL -> 마지막 발송 시간)
const emailSentHistory = new Map<string, number>();

// 메일 중복 발송 방지 시간 (30분)
const EMAIL_COOLDOWN_MS = 30 * 60 * 1000;

// 오늘 포함 1주일간의 날짜를 YYYYMMDD 형식으로 반환 (주말 포함)
const getWeekDates = (): string[] => {
  const dates: string[] = [];
  let currentDate = dayjs().tz('Asia/Seoul');

  for (let i = 0; i < 7; i += 1) {
    dates.push(currentDate.format('YYYYMMDD'));
    currentDate = currentDate.add(1, 'day');
  }

  return dates;
};

// 메일을 보낼 수 있는지 확인 (30분 이내 중복 발송 방지)
function canSendEmail(url: string): boolean {
  const now = Date.now();
  const lastSent = emailSentHistory.get(url);

  if (!lastSent) {
    return true;
  }

  const timeSinceLastSent = now - lastSent;
  return timeSinceLastSent >= EMAIL_COOLDOWN_MS;
}

// 메일 발송 기록 저장
function recordEmailSent(url: string): void {
  emailSentHistory.set(url, Date.now());
}

// 오래된 메일 발송 기록 정리 (30분 이상 지난 기록 삭제)
function cleanupOldEmailHistory(): void {
  const now = Date.now();
  const keysToDelete: string[] = [];

  emailSentHistory.forEach((timestamp, url) => {
    if (now - timestamp >= EMAIL_COOLDOWN_MS) {
      keysToDelete.push(url);
    }
  });

  keysToDelete.forEach((key) => {
    emailSentHistory.delete(key);
  });

  if (keysToDelete.length > 0) {
    console.log(`🧹 오래된 메일 발송 기록 ${keysToDelete.length}개 정리 완료`);
  }
}

async function sendEmail({ url, name }: { url: string; name: string }) {
  // 개발 모드일 때는 콘솔 로그만 출력
  if (isDevelopment) {
    console.log('\n========== 📧 메일 발송 (개발 모드 - 실제로 발송되지 않음) ==========');
    console.log(`수신자: ${targetEmailList.join(', ')}`);
    console.log(`제목: 단편선 ${name} 예약가능!!`);
    console.log('내용:');
    console.log(`  - ${url}`);
    console.log('================================================================\n');
    return;
  }

  // 프로덕션 모드일 때는 실제로 메일 발송
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: SENDER_GMAIL_USER,
      pass: SENDER_GMAIL_PASSWORD
    }
  });

  await transporter.sendMail({
    from: '"Yuki" <zz11zz3383@gmail.com>',
    to: targetEmailList.join(', '),
    subject: `단편선 ${name} 예약가능!!`,
    html: `
<p>
    단편선 <b>${name}</b> 예약가능<br>
    <br>
    <a href="${url}">${url}</a>
</p>
`
  });
}

type SearchTask = {
  idx: string;
  date: string;
  url: string;
};

// 각 URL을 탐색하는 함수
async function checkReservation(browser: Browser, task: SearchTask): Promise<void> {
  const page = await browser.newPage();

  try {
    const formattedDate = dayjs(task.date, 'YYYYMMDD').format('YYYY-MM-DD');
    console.log(`\n🔍 탐색 시작: idx=${task.idx}, date=${formattedDate}`);
    console.log(`   URL: ${task.url}`);

    await page.goto(task.url, { waitUntil: 'networkidle2' });
    await page.setViewport({ width: 1080, height: 1024 });

    // alert 다이얼로그 리스너 설정
    let alertAppeared = false;
    page.on('dialog', async (dialog) => {
      alertAppeared = true;
      console.log(`   ❌ Alert 발생: ${dialog.message()}`);
      await dialog.dismiss();
    });

    // 현재 URL 저장
    const currentUrl = page.url();

    // "예약하기" 버튼 찾기 (재시도 로직)
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

          // 예약하기 버튼 클릭
          await button.click();
          console.log('   ✓ "예약하기" 버튼 클릭');

          // .booking_content_detail > div 에서 텍스트 가져오기
          bookingName = await page.evaluate(() => {
            const detailElement = document.querySelector('.booking_content_detail > div');
            return detailElement ? detailElement.textContent?.trim() || '' : '';
          });

          break;
        }
      }

      if (reserveButtonFound) {
        break;
      }

      if (attempt < maxReserveButtonAttempts) {
        console.log(
          `   ⏳ "예약하기" 버튼을 찾을 수 없음, 새로고침 후 재시도... (${attempt}/${maxReserveButtonAttempts})`
        );
        // 페이지 새로고침
        await page.reload({ waitUntil: 'networkidle2' });
        await delay(500);
      }
    }

    if (!reserveButtonFound) {
      console.log('   ❌ "예약하기" 버튼을 찾을 수 없음 (최종 실패)');

      // HTML 코드 출력
      const htmlContent = await page.content();
      const separator = '='.repeat(78);
      console.log('\n   📄 페이지 HTML 코드:');
      console.log(`   ${separator}`);
      console.log(htmlContent);
      console.log(`   ${separator}\n`);
    } else {
      // 모달 팝업이 나타날 때까지 대기
      await delay(500);

      // "비회원 예약" 버튼 찾기 및 클릭 (재시도 로직)
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
            `   ⏳ "비회원 예약" 버튼을 찾을 수 없음, 재시도 중... (${attempt}/${maxNonMemberButtonAttempts})`
          );
          await delay(500);
        }
      }

      if (!nonMemberButtonClicked) {
        console.log('   ❌ "비회원 예약" 버튼을 찾을 수 없음 (최종 실패)\n');
      } else {
        // 리다이렉트 또는 alert 대기
        await delay(1000);

        // alert가 나타났는지 확인
        if (alertAppeared) {
          console.log('   ❌ 예약 불가 (alert 발생)\n');
        } else {
          // 리다이렉트 또는 alert 대기
          await delay(1000);

          // 페이지 리다이렉트 확인
          const newUrl = page.url();
          const redirected = currentUrl !== newUrl;

          if (redirected) {
            console.log('   ✅ 페이지 리다이렉트 감지 - 예약 가능!');

            console.log(`   📝 예약 이름: ${bookingName || '(이름 없음)'}`);

            // 30분 이내 중복 발송 확인
            if (canSendEmail(task.url)) {
              // 메일 발송
              await sendEmail({
                url: task.url,
                name: `${formattedDate} / ${bookingName}`
              });

              // 발송 기록 저장
              recordEmailSent(task.url);

              console.log('   ✅ 메일 발송 완료\n');
            } else {
              const lastSent = emailSentHistory.get(task.url);
              const minutesAgo = lastSent ? Math.floor((Date.now() - lastSent) / 1000 / 60) : 0;
              console.log(
                `   ⏭️  메일 발송 건너뜀 (${minutesAgo}분 전에 이미 발송됨, 30분 후 재발송 가능)\n`
              );
            }
          } else {
            console.log('   ⚠️ 리다이렉트가 발생하지 않음 - 상태 불명확\n');
          }
        }
      }
    }
  } catch (e) {
    console.log(`   ❌ 오류 발생:`, e);
  } finally {
    await page.close();
  }

  // 다음 탐색 전 딜레이 (429 에러 방지)
  await delay(1000);
}

// 한 사이클의 크롤링 작업을 수행하는 함수
async function runCrawlingCycle(cycleNumber: number): Promise<void> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(
    `🔄 사이클 #${cycleNumber} 시작 - ${dayjs().tz('Asia/Seoul').format('YYYY-MM-DD HH:mm:ss')}`
  );
  console.log(`${'='.repeat(80)}\n`);

  // 오래된 메일 발송 기록 정리
  cleanupOldEmailHistory();

  // 1주일간의 날짜 가져오기 (주말 포함)
  const weekDates = getWeekDates();
  console.log(
    `📅 검색 대상 날짜 (주말 포함): ${weekDates
      .map((d) => dayjs(d, 'YYYYMMDD').format('YYYY-MM-DD'))
      .join(', ')}\n`
  );

  // 각 idx와 날짜 조합으로 SearchTask 생성
  const searchTasks: SearchTask[] = [];

  for (const item of gSearchList) {
    for (const date of weekDates) {
      searchTasks.push({
        idx: item.idx,
        date,
        url: `${DPSNNN_G_URL}?idx=${item.idx}&day=${date}&endDay=${date}`
      });
    }
  }

  console.log(
    `🔍 총 ${searchTasks.length}개의 검색 작업 (idx ${gSearchList.length}개 × 날짜 ${weekDates.length}개)`
  );
  console.log(`⏱️  ${CONCURRENT_LIMIT}개씩 병렬로 처리합니다...\n`);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // CONCURRENT_LIMIT만큼 병렬로 처리
    for (let i = 0; i < searchTasks.length; i += CONCURRENT_LIMIT) {
      const batch = searchTasks.slice(i, i + CONCURRENT_LIMIT);
      const batchPromises = batch.map((task, index) => {
        const globalIndex = i + index + 1;
        console.log(`\n[${globalIndex}/${searchTasks.length}] 탐색 중...`);
        return checkReservation(browser, task);
      });

      // 현재 배치의 모든 작업이 완료될 때까지 대기
      await Promise.all(batchPromises);
    }

    console.log(`\n✅ 사이클 #${cycleNumber} 완료!`);
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`🚀 실행 모드: ${isDevelopment ? '개발(Development)' : '프로덕션(Production)'}`);
  if (isDevelopment) {
    console.log('📝 개발 모드에서는 기본값을 사용하며, 메일은 실제로 발송되지 않습니다.');
  }
  console.log('🔁 크롤링을 계속 반복합니다. 종료하려면 Ctrl+C를 누르세요.\n');

  let cycleNumber = 1;

  // 무한 루프로 계속 반복
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
  }
})();
