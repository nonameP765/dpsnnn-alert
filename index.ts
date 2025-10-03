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
const DPSNNN_SS_URL = 'https://dpsnnn-s.imweb.me/reserve_ss';
const {
  SENDER_GMAIL_USER,
  SENDER_GMAIL_PASSWORD,
  TARGET_GMAIL_USER,
  G_SEARCH_LIST,
  SS_SEARCH_LIST
} = process.env;

if (!SENDER_GMAIL_USER || !SENDER_GMAIL_PASSWORD || !TARGET_GMAIL_USER) {
  throw new Error('SENDER_GMAIL_USER and SENDER_GMAIL_PASSWORD and TARGET_GMAIL_USER must be set');
}

type SearchItem = { name: string };

// 환경변수에서 검색 리스트 파싱 (쉼표로 구분)
const parseSearchList = (envValue: string | undefined): SearchItem[] => {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
};

const gSearchList: SearchItem[] = parseSearchList(G_SEARCH_LIST);
const ssSearchList: SearchItem[] = parseSearchList(SS_SEARCH_LIST);

async function sendEmail({
  urlList,
  name
}: {
  urlList: {
    name: string;
    value: string;
  }[];
  name: string;
}) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: SENDER_GMAIL_USER,
      pass: SENDER_GMAIL_PASSWORD
    }
  });

  await transporter.sendMail({
    from: '"Yuki" <nonamep@setsuna.kr>',
    to: TARGET_GMAIL_USER,
    subject: `단편선 ${name} 예약가능!!`,
    html: `
<p>
    단편선 <b>${name}</b> 예약가능<br>
    <br>
    ${urlList
      .map((url) => {
        const urlQuery = new URL(url.value);
        const urlQueryParams = urlQuery.searchParams;
        const day = urlQueryParams.get('day');
        const date = day ? dayjs(day).format('YYYY-MM-DD') : '';
        return `<a href="${url.value}">${date ? `${date} ` : ''}${url.name.split(' / ')[1]}</a>`;
      })
      .join('<br>')}
</p>
`
  });
}

async function processSearchItem(
  browser: Browser,
  item: SearchItem,
  url: string,
  category: string
) {
  const page = await browser.newPage();

  try {
    await page.goto(url);
    await page.setViewport({ width: 1080, height: 1024 });

    await page.waitForSelector('.booking_list', {
      timeout: 5000
    });

    const availableBookings = await page.evaluate((searchName: string) => {
      const bookingItems = Array.from(document.querySelectorAll('.booking_list'));
      return bookingItems
        .filter((item) => !item.classList.contains('closed'))
        .filter((item) => {
          const text = item.textContent?.trim() || '';
          return text.includes(searchName);
        })
        .map((item) => {
          const text = item.textContent?.trim() || '';
          const link = item.querySelector('a')?.getAttribute('href') || '';
          return { text, link };
        });
    }, item.name);

    if (availableBookings.length > 0) {
      console.log(`[${category}] ${item.name} - 예약 가능한 항목들:`);

      // URL에서 베이스 URL 추출 (프로토콜 + 도메인)
      const urlObj = new URL(url);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

      const sendEmailList = availableBookings
        .map((booking: { text: string; link: string }) => {
          if (booking.link) {
            const fullUrl = booking.link.startsWith('http')
              ? booking.link
              : `${baseUrl}${booking.link.startsWith('/') ? booking.link : `/${booking.link}`}`;
            return { name: booking.text, value: fullUrl };
          }
          return null;
        })
        .filter((item) => item !== null);

      await sendEmail({
        urlList: sendEmailList,
        name: item.name
      });
    } else {
      console.log(`[${category}] ${item.name} - 예약 가능한 항목이 없습니다`);
    }
  } catch (e) {
    console.log(`[${category}] ${item.name} - booking_list를 찾을 수 없습니다`);
  } finally {
    await page.close();
  }
}

(async () => {
  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // G와 SS 검색을 병렬로 처리
    const searchTasks = [
      ...gSearchList.map((item) => processSearchItem(browser, item, DPSNNN_G_URL, '강남')),
      ...ssSearchList.map((item) => processSearchItem(browser, item, DPSNNN_SS_URL, '성수'))
    ];

    await Promise.all(searchTasks);

    await browser.close();

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
