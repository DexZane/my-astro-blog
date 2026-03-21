import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const urls = [
  { key: 'home', url: 'http://127.0.0.1:4321/my-astro-blog/' },
  { key: 'blog', url: 'http://127.0.0.1:4321/my-astro-blog/blog/' },
  { key: 'search', url: 'http://127.0.0.1:4321/my-astro-blog/search/' },
];

const viewports = [
  { w: 375, h: 667, label: 'iPhone_SE_375x667' },
  { w: 390, h: 844, label: 'iPhone_12_13_390x844' },
  { w: 430, h: 932, label: 'iPhone_14_15ProMax_430x932' },
  { w: 440, h: 956, label: 'iPhone_16ProMax_440x956' },
  { w: 448, h: 972, label: 'iPhone_17ProMax_448x972' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const consoleErrors = [];

  const reportsDir = path.resolve(process.cwd(), 'qa-reports');
  const screenshotsDir = path.resolve(reportsDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  for (const vp of viewports) {
    for (const u of urls) {
      const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await context.newPage();

      page.on('console', msg => {
        if (['error', 'warning'].includes(msg.type())) {
          consoleErrors.push({ viewport: vp.label, url: u.url, type: msg.type(), text: msg.text() });
        }
      });

      page.on('pageerror', err => {
        consoleErrors.push({ viewport: vp.label, url: u.url, type: 'runtime_error', text: err.message });
      });

      const result = { page: u.key, url: u.url, viewport: vp.label, pass: true, issues: [] };

      try {
        await page.goto(u.url, { waitUntil: 'networkidle', timeout: 30000 });

        // 1. Header nav check (no overlap/clip)
        const header = await page.$('header');
        if (header) {
          const hBox = await header.boundingBox();
          if (!hBox || hBox.width <= 0 || hBox.height <= 0) {
            result.pass = false;
            result.issues.push('Header nav is not visible or has zero size.');
          } else {
            // Check if header is within viewport width
            if (hBox.width > vp.w + 1) {
              result.pass = false;
              result.issues.push(`Header width (${hBox.width}) exceeds viewport width (${vp.w}).`);
            }
          }
        } else {
          result.pass = false;
          result.issues.push('Header element not found.');
        }

        // 2. Home page buttons (tappable, not cropped)
        if (u.key === 'home') {
          const btns = await page.$$('a, button');
          let visibleBtnCount = 0;
          for (const btn of btns) {
            const bb = await btn.boundingBox();
            if (bb && bb.width > 0 && bb.height > 0) {
              // Check if button is at least partially in viewport and not clipped by width
              if (bb.x < 0 || bb.x + bb.width > vp.w) {
                result.pass = false;
                result.issues.push(`Button/Link clipped by viewport width: ${await btn.innerText()}`);
              }
              visibleBtnCount++;
            }
          }
          if (visibleBtnCount === 0) {
            result.pass = false;
            result.issues.push('No visible buttons or links found on home page.');
          }
        }

        // 3. Blog/Search: sidebar/filter stacks correctly, no horizontal scroll
        const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        if (hasHScroll) {
          result.pass = false;
          result.issues.push('Page has horizontal scroll.');
        }

        if (u.key === 'blog') {
          const aside = await page.$('aside');
          if (aside) {
            const aBox = await aside.boundingBox();
            if (aBox && aBox.width > vp.w + 1) {
              result.pass = false;
              result.issues.push('Blog sidebar wider than viewport.');
            }
          }
        }

        // 4. Search: quick tags tappable, search results readable
        if (u.key === 'search') {
          // Assuming tags might have a specific class or just be links/buttons in a certain area
          const tags = await page.$$('.tag, .quick-tag, button, a'); 
          // This is broad, but we'll check if any are visible and within bounds
          let tagFound = false;
          for (const tag of tags) {
            const bb = await tag.boundingBox();
            if (bb && bb.width > 0 && bb.height > 0 && bb.x >= 0 && bb.x + bb.width <= vp.w) {
              tagFound = true;
              break;
            }
          }
          if (!tagFound) {
            result.pass = false;
            result.issues.push('No tappable quick tags found within viewport bounds.');
          }

          const cards = await page.$$('.card, .result, article');
          if (cards.length === 0) {
            // If no cards, maybe search hasn't run or selectors are wrong, but we should check if the area is readable
          } else {
            const firstCard = cards[0];
            const cBox = await firstCard.boundingBox();
            if (cBox && (cBox.width > vp.w + 1 || cBox.width < 100)) {
              result.pass = false;
              result.issues.push('Search result card layout looks broken (too wide or too narrow).');
            }
          }
        }

      } catch (err) {
        result.pass = false;
        result.issues.push(`Navigation/Test error: ${err.message}`);
      }

      // Capture screenshot
      const screenshotPath = path.resolve(screenshotsDir, `${u.key}_${vp.label}.png`);
      await page.screenshot({ path: screenshotPath });

      await context.close();
      results.push(result);
    }
  }

  await browser.close();

  // Output Report
  console.log('\n--- BROWSER QA REPORT ---');
  results.forEach(r => {
    const status = r.pass ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} | ${r.page.padEnd(6)} | ${r.viewport.padEnd(25)} | ${r.url}`);
    if (r.issues.length > 0) {
      r.issues.forEach(issue => { console.log(`   - ${issue}`); });
    }
  });

  if (consoleErrors.length > 0) {
    console.log('\n--- CONSOLE/RUNTIME ERRORS ---');
    consoleErrors.forEach(e => {
      console.log(`[${e.viewport}] ${e.type.toUpperCase()}: ${e.text} (${e.url})`);
    });
  } else {
    console.log('\n✅ No console or runtime errors detected.');
  }

  fs.writeFileSync(path.resolve(reportsDir, 'summary.json'), JSON.stringify({ results, consoleErrors }, null, 2));
})();
