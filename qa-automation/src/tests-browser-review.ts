import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { CaptureRecord, FailureRecord } from './types.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const desktopViewport = { width: 1536, height: 1024 };
const mobileViewport = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const certificationMode = String(process.env.QA_TEST_CERTIFICATION_MODE || '').toLowerCase() === 'true';
const expectedQuestions = Math.max(0, Number(process.env.QA_TEST_EXPECTED_QUESTIONS || 0));
const expectedDurationMinutes = Math.max(0, Number(process.env.QA_TEST_EXPECTED_DURATION_MINUTES || 0));
const targetTestTitle = String(process.env.QA_TEST_TITLE || '').trim();
const autoSubmitOverrideSeconds = Math.max(0, Number(process.env.QA_TEST_AUTO_SUBMIT_SECONDS || 0));
const skipMobileReview = String(process.env.QA_TEST_SKIP_MOBILE || '').toLowerCase() === 'true';

const loginAndStoreSession = async (page: puppeteer.Page, email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Tests Review',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || 'Unable to login for tests review');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('edumaster.jwt', token);
  }, payload.token as string);
};

const takeScreenshot = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  stepId: string,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, stepId, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, stepId, label, 'html');
  const originalViewport = page.viewport();
  const fullHeight = await page.evaluate(() =>
    Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
      document.documentElement.clientHeight,
    ),
  );

  if (originalViewport && fullHeight > originalViewport.height) {
    await page.setViewport({ ...originalViewport, height: Math.min(fullHeight, 12000) });
    await sleep(100);
  }

  await page.screenshot({ path: screenshotPath });

  if (originalViewport && fullHeight > originalViewport.height) {
    await page.setViewport(originalViewport);
    await sleep(100);
  }
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

const recordFailure = (
  failures: FailureRecord[],
  stepId: string,
  title: string,
  description: string,
  screenshotPath?: string,
) => {
  failures.push({
    stepId,
    title,
    description,
    severity: 'high',
    timestamp: new Date().toISOString(),
    screenshotPath,
  });
};

const openTestsTab = async (page: puppeteer.Page, mode: 'desktop' | 'mobile') => {
  const preferredSelector = mode === 'desktop' ? selectors.navTests : selectors.mobileNavTests;
  const clickedPreferred = await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector) as HTMLElement | null;
    if (!element) {
      return false;
    }

    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, preferredSelector);

  if (clickedPreferred) {
    return;
  }

  await page.evaluate(() => {
    const candidate = [...document.querySelectorAll('button')].find((button) =>
      /(mock tests|tests)/i.test((button.textContent || '').trim()),
    ) as HTMLButtonElement | undefined;
    candidate?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const waitForAnySelector = async (page: puppeteer.Page, selectorList: string[], timeout = 30000) => {
  await page.waitForFunction(
    (selectorsToCheck) => selectorsToCheck.some((selector) => Boolean(document.querySelector(selector))),
    { timeout },
    selectorList,
  );
};

const clickFirstAvailable = async (page: puppeteer.Page, selectorList: string[], textMatchers: RegExp[] = []) => {
  for (const selector of selectorList) {
    const clicked = await page.evaluate((targetSelector) => {
      const elements = [...document.querySelectorAll(targetSelector)] as HTMLElement[];
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        element.click();
        return true;
      }
      return false;
    }, selector);

    if (clicked) {
      return true;
    }
  }

  if (textMatchers.length > 0) {
    const matched = await page.evaluate((patterns) => {
      const regexes = patterns.map((pattern) => new RegExp(pattern, 'i'));
      const elements = [...document.querySelectorAll('button, a')] as HTMLElement[];
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        if (!regexes.some((regex) => regex.test((element.textContent || '').trim()))) {
          continue;
        }

        element.click();
        return true;
      }

      return false;
    }, textMatchers.map((pattern) => pattern.source));

    return matched;
  }

  return false;
};

const clickTestByTitle = async (page: puppeteer.Page, title: string) => page.evaluate((targetTitle) => {
  const normalizedTarget = targetTitle.toLowerCase().trim();
  const candidates = [...document.querySelectorAll('button')] as HTMLElement[];
  for (const candidate of candidates) {
    const text = (candidate.textContent || '').toLowerCase();
    if (!text.includes(normalizedTarget)) {
      continue;
    }

    const style = window.getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    candidate.click();
    return true;
  }

  return false;
}, title);

const getVisibleBodyText = async (page: puppeteer.Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const getVisibleText = async (page: puppeteer.Page, selector: string) => page.evaluate((targetSelector) => {
  const elements = [...document.querySelectorAll(targetSelector)] as HTMLElement[];
  for (const element of elements) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    return (element.textContent || '').trim();
  }

  return '';
}, selector);

const ensureChecked = async (page: puppeteer.Page, selector: string) => {
  const checkboxHandles = await page.$$(selector);
  for (const handle of checkboxHandles) {
    const box = await handle.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      continue;
    }

    const isVisible = await handle.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });

    if (!isVisible) {
      continue;
    }

    await handle.click();
    await page.waitForFunction(
      (targetSelector) => {
        const nodes = [...document.querySelectorAll(targetSelector)] as HTMLElement[];
        return nodes.some((node) => {
          const input = node instanceof HTMLInputElement ? node : node.querySelector('input[type="checkbox"]');
          return Boolean(input?.checked);
        });
      },
      { timeout: 2000 },
      selector,
    ).catch(() => undefined);

    const becameChecked = await page.evaluate((targetSelector) => {
      const nodes = [...document.querySelectorAll(targetSelector)] as HTMLElement[];
      return nodes.some((node) => {
        const input = node instanceof HTMLInputElement ? node : node.querySelector('input[type="checkbox"]');
        return Boolean(input?.checked);
      });
    }, selector);

    if (becameChecked) {
      return true;
    }
  }

  const checked = await page.evaluate(() => {
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    for (const checkbox of checkboxes) {
      const style = window.getComputedStyle(checkbox);
      const rect = checkbox.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      checkbox.click();
      return true;
    }

    return false;
  });

  return checked;
};

const getVisibleQuestionCount = async (page: puppeteer.Page, selectorPrefix: string) => page.evaluate((prefix) => {
  const items = [...document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)];
  return items.filter((item) => {
    const style = window.getComputedStyle(item);
    const rect = item.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }).length;
}, selectorPrefix);

const selectFirstVisibleAnswer = async (page: puppeteer.Page) => page.evaluate(() => {
  const optionLabels = [...document.querySelectorAll('label')] as HTMLElement[];
  for (const label of optionLabels) {
    const input = label.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
    if (!input) {
      continue;
    }

    const style = window.getComputedStyle(label);
    const rect = label.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    label.click();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
});

const hasVisibleSelection = async (page: puppeteer.Page) => page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')] as HTMLInputElement[];
  return inputs.some((input) => {
    if (!input.checked) {
      return false;
    }

    const target = (input.closest('label') || input) as HTMLElement;
    const style = window.getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  });
});

const goToBaseAndLogin = async (page: puppeteer.Page) => {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await loginAndStoreSession(page, process.env.QA_LOGIN_EMAIL || config.loginEmail, process.env.QA_LOGIN_PASSWORD || config.loginPassword);
  if (autoSubmitOverrideSeconds > 0) {
    await page.evaluate((seconds) => {
      window.localStorage.setItem('qa.mock_test_timer_override_seconds', String(seconds));
    }, autoSubmitOverrideSeconds);
  } else {
    await page.evaluate(() => {
      window.localStorage.removeItem('qa.mock_test_timer_override_seconds');
    });
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 30000 });
};

const captureStep = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  stepId: string,
  label: string,
) => {
  const { screenshotPath, sourcePath } = await takeScreenshot(page, ctx, stepId, label);
  captures.push({
    stepId,
    label,
    state: 'ui',
    durationMs: 0,
    screenshotPath,
    sourcePath,
    timestamp: new Date().toISOString(),
  });
  return screenshotPath;
};

const verifyConfirmationExpectations = async (
  page: puppeteer.Page,
  failures: FailureRecord[],
  stepId: string,
  screenshotPath: string,
) => {
  if (!certificationMode) {
    return;
  }

  const text = await getVisibleBodyText(page);
  if (expectedQuestions > 0 && !new RegExp(`\\b${expectedQuestions}\\b`).test(text)) {
    recordFailure(
      failures,
      stepId,
      'Expected question count is not visible on confirmation',
      `The confirmation screen should clearly show ${expectedQuestions} questions for the certification mock.`,
      screenshotPath,
    );
  }

  if (expectedDurationMinutes > 0 && !new RegExp(`\\b${expectedDurationMinutes}\\b`).test(text)) {
    recordFailure(
      failures,
      stepId,
      'Expected duration is not visible on confirmation',
      `The confirmation screen should clearly show ${expectedDurationMinutes} minutes for the certification mock.`,
      screenshotPath,
    );
  }
};

const jumpToQuestion = async (page: puppeteer.Page, selector: string) => {
  const clicked = await page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector) as HTMLElement | null;
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, selector);

  if (clicked) {
    await sleep(300);
  }

  return clicked;
};

const waitForRankTransition = async (
  page: puppeteer.Page,
  rankSelector: string,
  percentileSelector: string,
  failures: FailureRecord[],
  stepId: string,
  screenshotPath: string,
) => {
  if (!certificationMode) {
    return;
  }

  const rankBefore = await getVisibleText(page, rankSelector);
  if (!/pending/i.test(rankBefore)) {
    return;
  }

  const ready = await page.waitForFunction(
    (rankSel, percentileSel) => {
      const rankText = (document.querySelector(rankSel)?.textContent || '').trim();
      const percentileText = (document.querySelector(percentileSel)?.textContent || '').trim();
      return rankText.startsWith('#') || /\d+(\.\d+)?%/.test(percentileText);
    },
    { timeout: 15000 },
    rankSelector,
    percentileSelector,
  ).then(() => true).catch(() => false);

  if (!ready) {
    recordFailure(
      failures,
      stepId,
      'Pending rank never became ready on the result screen',
      'The result screen should refresh from pending to ready once async ranking finishes.',
      screenshotPath,
    );
  }
};

const reviewDesktopFlow = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  failures: FailureRecord[],
) => {
  await page.setViewport(desktopViewport);
  await goToBaseAndLogin(page);
  await openTestsTab(page, 'desktop');
  await waitForAnySelector(page, [selectors.testsFigmaPage, selectors.firstTestCard]);
  await sleep(600);

  const homeShot = await captureStep(page, ctx, captures, 'tests-home-desktop', 'tests-home-desktop');
  if (!(await page.$(selectors.testsHomeDesktop))) {
    recordFailure(
      failures,
      'tests-home-desktop',
      'Desktop tests home does not match target structure',
      'Expected a dedicated desktop Test Series home screen, but the current implementation only exposes the legacy mock-test grid.',
      homeShot,
    );
  }

  const clickedTargetTest = targetTestTitle ? await clickTestByTitle(page, targetTestTitle) : false;
  if (!clickedTargetTest) {
    await clickFirstAvailable(page, [selectors.testsOpenPrimary, selectors.firstTestCard], [/open exam instructions/i, /resume now/i, /start now/i]);
  }
  await sleep(700);

  const hasDetail = Boolean(await page.$(selectors.testsDetailDesktop));
  if (hasDetail) {
    await captureStep(page, ctx, captures, 'tests-detail-desktop', 'tests-detail-desktop');
    await clickFirstAvailable(page, [selectors.testsOpenInstructions], [/resume now/i, /start now/i, /go to test series/i, /paper/i]);
    await sleep(600);
  } else {
    recordFailure(
      failures,
      'tests-detail-desktop',
      'Desktop test detail screen missing',
      'The current flow jumps directly from the home list into instructions instead of rendering the dedicated series detail page from the Figma.',
      homeShot,
    );
  }

  await waitForAnySelector(page, [selectors.testsInstructionsDesktop, 'button[data-testid="test-player-close"]']);
  const instructionsShot = await captureStep(page, ctx, captures, 'tests-instructions-desktop', 'tests-instructions-desktop');
  if (!(await page.$(selectors.testsInstructionsDesktop))) {
    recordFailure(
      failures,
      'tests-instructions-desktop',
      'Desktop instructions screen is still using the legacy CBT layout',
      'The instructions screen is not using the new exact desktop instructions composition required by the Figma.',
      instructionsShot,
    );
  }

  await clickFirstAvailable(page, [selectors.testsInstructionsNextDesktop], [/^next$/i]);
  await sleep(500);
  await waitForAnySelector(page, [selectors.testsConfirmationDesktop, selectors.testsExamDesktop, 'input[type="checkbox"]']);

  const hasConfirmation = Boolean(await page.$(selectors.testsConfirmationDesktop)) || Boolean(await page.$('input[type="checkbox"]'));
  const confirmationShot = await captureStep(page, ctx, captures, 'tests-confirmation-desktop', 'tests-confirmation-desktop');
  await verifyConfirmationExpectations(page, failures, 'tests-confirmation-desktop', confirmationShot);
  if (!hasConfirmation || !(await page.$(selectors.testsConfirmationDesktop))) {
    recordFailure(
      failures,
      'tests-confirmation-desktop',
      'Desktop confirmation screen is not matching target',
      'The confirmation screen should mirror the Figma confirmation layout before the exam begins.',
      confirmationShot,
    );
  }

  await ensureChecked(page, selectors.testsConfirmationCheckboxDesktop);
  await clickFirstAvailable(page, [], [/^previous$/i]);
  await waitForAnySelector(page, [selectors.testsInstructionsDesktop]);
  await clickFirstAvailable(page, [], [/go to tests/i]);
  await waitForAnySelector(page, [selectors.testsDetailDesktop]);

  const detailActionLabel = await getVisibleText(page, selectors.testsOpenInstructions);
  if (/resume/i.test(detailActionLabel)) {
    recordFailure(
      failures,
      'tests-confirmation-state-desktop',
      'Desktop confirmation screen marks the test as resumed too early',
      'Checking the declaration should not flip the detail CTA from Start to Resume until the learner actually begins the exam.',
      confirmationShot,
    );
  }

  await clickFirstAvailable(page, [selectors.testsOpenInstructions], [/resume now/i, /start now/i, /go to test series/i, /paper/i]);
  await waitForAnySelector(page, [selectors.testsInstructionsDesktop]);
  await clickFirstAvailable(page, [selectors.testsInstructionsNextDesktop], [/^next$/i]);
  await waitForAnySelector(page, [selectors.testsConfirmationDesktop, 'input[type="checkbox"]']);
  await ensureChecked(page, selectors.testsConfirmationCheckboxDesktop);
  await page.waitForFunction(
    (targetSelector) => {
      const button = document.querySelector(targetSelector) as HTMLButtonElement | null;
      return Boolean(button && !button.disabled);
    },
    { timeout: 5000 },
    selectors.testsConfirmationBeginDesktop,
  );
  if (certificationMode && await page.$(selectors.testsExamTimerDesktop)) {
    recordFailure(
      failures,
      'tests-confirmation-timer-desktop',
      'Desktop timer appeared before the learner began the exam',
      'The countdown should not render on the confirmation screen before "I am ready to begin" is clicked.',
      confirmationShot,
    );
  }
  await clickFirstAvailable(page, [selectors.testsConfirmationBeginDesktop], [/i am ready to begin/i, /ready to begin/i]);
  await sleep(900);
  await waitForAnySelector(page, [selectors.testsExamDesktop, selectors.testsExamSubmitDesktop]);
  if (certificationMode) {
    await page.waitForSelector(selectors.testsExamTimerDesktop, { timeout: 5000 }).catch(() => undefined);
  }

  const examShot = await captureStep(page, ctx, captures, 'tests-exam-desktop', 'tests-exam-desktop');
  if (!(await page.$(selectors.testsExamDesktop))) {
    recordFailure(
      failures,
      'tests-exam-desktop',
      'Desktop exam screen is not matching the target layout',
      'The main desktop test-taking screen still differs from the Figma in structure, palette treatment, and controls.',
      examShot,
    );
  }

  const questionCount = await getVisibleQuestionCount(page, 'tests-desktop-jump-');
  const runAdvancedDesktopParityChecks = questionCount > 1;
  if (certificationMode && autoSubmitOverrideSeconds === 0 && questionCount >= 100) {
    const navigatedToSixty = await jumpToQuestion(page, '[data-testid="tests-desktop-jump-60"]');
    const navigatedToLast = await jumpToQuestion(page, `[data-testid="tests-desktop-jump-${questionCount}"]`);
    if (!navigatedToSixty || !navigatedToLast) {
      recordFailure(
        failures,
        'tests-exam-desktop-large-navigation',
        'Large-paper desktop navigation did not reach deep questions',
        `The certification mock should allow direct palette navigation deep into the paper; expected question 60 and question ${questionCount}.`,
        examShot,
      );
    }
  }
  const clickedDesktopOption = autoSubmitOverrideSeconds > 0 ? true : await selectFirstVisibleAnswer(page);
  await sleep(250);
  const selectedDesktopShot = await captureStep(page, ctx, captures, 'tests-exam-desktop-selected', 'tests-exam-desktop-selected');
  const hasDesktopSelection = autoSubmitOverrideSeconds > 0 ? true : await hasVisibleSelection(page);
  if (runAdvancedDesktopParityChecks && (!clickedDesktopOption || !hasDesktopSelection)) {
    recordFailure(
      failures,
      'tests-exam-desktop-selected',
      'Desktop answer selection state did not apply',
      'Selecting an option in the desktop exam should immediately show the chosen radio state before navigation.',
      selectedDesktopShot,
    );
  }

  if (runAdvancedDesktopParityChecks && autoSubmitOverrideSeconds === 0) {
    await clickFirstAvailable(page, [], [/save & next/i]);
    await sleep(400);
    const savedDesktopShot = await captureStep(page, ctx, captures, 'tests-exam-desktop-saved-next', 'tests-exam-desktop-saved-next');
    if (!(await page.$(selectors.testsExamDesktop))) {
      recordFailure(
        failures,
        'tests-exam-desktop-saved-next',
        'Desktop save & next interaction broke the exam flow',
        'Saving the first desktop answer should advance to the next question while keeping the palette and counts updated.',
        savedDesktopShot,
      );
    }

    const clickedSecondDesktopOption = await selectFirstVisibleAnswer(page);
    await sleep(250);
    await clickFirstAvailable(page, [], [/save & next/i]);
    await sleep(400);
    const returnedToQuestionTwo = await page.evaluate(() => {
      const target = document.querySelector('[data-testid="tests-desktop-jump-2"]') as HTMLElement | null;
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return Boolean(target);
    });
    await sleep(350);
    await clickFirstAvailable(page, [], [/mark for review/i]);
    await sleep(250);
    const reviewDesktopShot = await captureStep(page, ctx, captures, 'tests-exam-desktop-review-state', 'tests-exam-desktop-review-state');
    if (!(await page.$(selectors.testsExamDesktop)) || !clickedSecondDesktopOption || !returnedToQuestionTwo) {
      recordFailure(
        failures,
        'tests-exam-desktop-review-state',
        'Desktop review/save interaction broke the exam flow',
        'Saving, revisiting, and toggling review on a desktop question should keep the user inside the exam with the updated question state.',
        reviewDesktopShot,
      );
    }
  }

  if (runAdvancedDesktopParityChecks && autoSubmitOverrideSeconds === 0) {
    await clickFirstAvailable(page, [selectors.testsDesktopOpenSymbols], [/symbols/i]);
    await sleep(300);
    const symbolsDesktopShot = await captureStep(page, ctx, captures, 'tests-symbols-desktop', 'tests-symbols-desktop');
    if (!(await page.$(selectors.testsDesktopSymbolsOverlay))) {
      recordFailure(
        failures,
        'tests-symbols-desktop',
        'Desktop symbols interaction did not open the symbols panel',
        'Clicking SYMBOLS should open the dedicated legend overlay that matches the Figma exam interaction.',
        symbolsDesktopShot,
      );
    }

    await clickFirstAvailable(page, [selectors.testsDesktopOpenInstructions], [/instructions/i]);
    await sleep(300);
    const instructionsOverlayDesktopShot = await captureStep(page, ctx, captures, 'tests-exam-instructions-desktop', 'tests-exam-instructions-desktop');
    if (!(await page.$(selectors.testsDesktopInstructionsOverlay))) {
      recordFailure(
        failures,
        'tests-exam-instructions-desktop',
        'Desktop instructions interaction did not open the in-exam instructions overlay',
        'Clicking INSTRUCTIONS from the desktop exam should open the large scrollable instructions overlay.',
        instructionsOverlayDesktopShot,
      );
    }

    await clickFirstAvailable(page, [selectors.testsDesktopOpenSummary], [/overall test summary/i]);
    await sleep(300);
    const summaryDesktopShot = await captureStep(page, ctx, captures, 'tests-summary-desktop', 'tests-summary-desktop');
    if (!(await page.$(selectors.testsDesktopSummaryOverlay))) {
      recordFailure(
        failures,
        'tests-summary-desktop',
        'Desktop overall summary interaction did not open the summary overlay',
        'Clicking OVERALL TEST SUMMARY should open the centered summary state from the Figma.',
        summaryDesktopShot,
      );
    }

    await clickFirstAvailable(page, [selectors.testsDesktopOpenSummary], [/overall test summary/i]);
    await sleep(250);
  }
  if (autoSubmitOverrideSeconds > 0) {
    await page.waitForSelector(selectors.testsResultDesktop, { timeout: 10000 }).catch(() => undefined);
  } else {
    await clickFirstAvailable(page, [selectors.testsExamSubmitDesktop], [/submit test/i, /submit/i]);
    await sleep(800);
  }

  const resultDesktopShot = await captureStep(page, ctx, captures, 'tests-result-desktop', 'tests-result-desktop');
  if (!(await page.$(selectors.testsResultDesktop))) {
    recordFailure(
      failures,
      'tests-result-desktop',
      'Desktop result screen missing',
      'Submitting the desktop exam should open the dedicated result summary screen.',
      resultDesktopShot,
    );
  }

  await waitForRankTransition(
    page,
    selectors.testsResultRankDesktop,
    selectors.testsResultPercentileDesktop,
    failures,
    'tests-result-rank-desktop',
    resultDesktopShot,
  );

  await clickFirstAvailable(page, [selectors.testsViewSolutionsDesktop], [/view solutions/i, /view analysis/i, /solutions/i]);
  await sleep(700);
  const solutionsDesktopShot = await captureStep(page, ctx, captures, 'tests-solutions-desktop', 'tests-solutions-desktop');
  if (!(await page.$(selectors.testsSolutionsDesktop))) {
    recordFailure(
      failures,
      'tests-solutions-desktop',
      'Desktop solutions screen missing',
      'The desktop result flow should include the solutions and analysis screen after clicking View Solutions.',
      solutionsDesktopShot,
    );
  }
};

const reviewMobileFlow = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  failures: FailureRecord[],
) => {
  await page.setViewport(mobileViewport);
  await goToBaseAndLogin(page);
  await openTestsTab(page, 'mobile');
  await waitForAnySelector(page, [selectors.testsFigmaPage, selectors.firstTestCard]);
  await sleep(700);

  const homeShot = await captureStep(page, ctx, captures, 'tests-home-mobile', 'tests-home-mobile');
  if (!(await page.$(selectors.testsHomeMobile))) {
    recordFailure(
      failures,
      'tests-home-mobile',
      'Mobile tests home does not match target structure',
      'Expected the dedicated mobile Test Series home screen with horizontal card rails and search header.',
      homeShot,
    );
  }

  const clickedTargetTest = targetTestTitle ? await clickTestByTitle(page, targetTestTitle) : false;
  if (!clickedTargetTest) {
    await clickFirstAvailable(page, [selectors.testsOpenPrimary, selectors.firstTestCard], [/open exam instructions/i, /resume now/i, /start now/i]);
  }
  await sleep(700);

  const hasDetail = Boolean(await page.$(selectors.testsDetailMobile));
  if (hasDetail) {
    await captureStep(page, ctx, captures, 'tests-detail-mobile', 'tests-detail-mobile');
    await clickFirstAvailable(page, [selectors.testsOpenInstructions], [/resume now/i, /start now/i, /paper/i]);
    await sleep(600);
  } else {
    recordFailure(
      failures,
      'tests-detail-mobile',
      'Mobile test detail screen missing',
      'The mobile flow should open a dedicated test detail page before instructions.',
      homeShot,
    );
  }

  await waitForAnySelector(page, [selectors.testsInstructionsMobile, selectors.testsInstructionsDesktop, 'button[data-testid="test-player-close"]']);
  const instructionsShot = await captureStep(page, ctx, captures, 'tests-instructions-mobile', 'tests-instructions-mobile');
  if (!(await page.$(selectors.testsInstructionsMobile))) {
    recordFailure(
      failures,
      'tests-instructions-mobile',
      'Mobile instructions screen is not matching target',
      'The mobile instructions screen should have the exact single-column composition from the Figma.',
      instructionsShot,
    );
  }

  await clickFirstAvailable(page, [selectors.testsInstructionsNextMobile], [/^next$/i]);
  await sleep(500);
  await waitForAnySelector(page, [selectors.testsConfirmationMobile, selectors.testsConfirmationDesktop, 'input[type="checkbox"]']);
  const confirmationShot = await captureStep(page, ctx, captures, 'tests-confirmation-mobile', 'tests-confirmation-mobile');
  await verifyConfirmationExpectations(page, failures, 'tests-confirmation-mobile', confirmationShot);
  if (!(await page.$(selectors.testsConfirmationMobile))) {
    recordFailure(
      failures,
      'tests-confirmation-mobile',
      'Mobile confirmation screen is not matching target',
      'The mobile confirmation screen should follow the Figma confirmation card and CTA layout.',
      confirmationShot,
    );
  }

  await ensureChecked(page, selectors.testsConfirmationCheckboxMobile);
  await page.waitForFunction(
    (targetSelector) => {
      const button = document.querySelector(targetSelector) as HTMLButtonElement | null;
      return Boolean(button && !button.disabled);
    },
    { timeout: 5000 },
    selectors.testsConfirmationBeginMobile,
  );
  if (certificationMode && await page.$(selectors.testsExamTimerMobile)) {
    recordFailure(
      failures,
      'tests-confirmation-timer-mobile',
      'Mobile timer appeared before the learner began the exam',
      'The countdown should not render on mobile before "I am ready to begin" is clicked.',
      confirmationShot,
    );
  }
  await clickFirstAvailable(page, [selectors.testsConfirmationBeginMobile], [/i am ready to begin/i, /ready to begin/i]);
  await sleep(900);
  await waitForAnySelector(page, [selectors.testsExamMobile, selectors.testsExamSubmitMobile]);
  if (certificationMode) {
    await page.waitForSelector(selectors.testsExamTimerMobile, { timeout: 5000 }).catch(() => undefined);
  }

  const mobileQuestionCount = await getVisibleQuestionCount(page, 'tests-mobile-jump-');
  await selectFirstVisibleAnswer(page);
  await sleep(200);
  if (mobileQuestionCount > 1) {
    await clickFirstAvailable(page, [], [/save & next/i]);
    await sleep(250);

    await selectFirstVisibleAnswer(page);
    await sleep(200);
    await clickFirstAvailable(page, [], [/save & next/i]);
    await sleep(250);

    await clickFirstAvailable(page, [], [/mark review/i]);
    await sleep(250);
    await clickFirstAvailable(page, [], [/save & next/i]);
    await sleep(250);

    await selectFirstVisibleAnswer(page);
    await sleep(200);
    await clickFirstAvailable(page, [], [/mark review/i]);
    await sleep(250);
    await clickFirstAvailable(page, [selectors.testsMobileJumpQuestion1]);
    await sleep(300);
  }

  const examShot = await captureStep(page, ctx, captures, 'tests-exam-mobile', 'tests-exam-mobile');
  if (!(await page.$(selectors.testsExamMobile))) {
    recordFailure(
      failures,
      'tests-exam-mobile',
      'Mobile exam screen is not matching target',
      'The mobile exam interface should match the compact Figma layout with palette access and bottom action bar.',
      examShot,
    );
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await clickFirstAvailable(page, [selectors.testsPaletteOpenMobile], [/question palette/i, /palette/i, /menu/i]);
  await sleep(500);
  const paletteShot = await captureStep(page, ctx, captures, 'tests-palette-mobile', 'tests-palette-mobile');
  if (!(await page.$(selectors.testsMobilePalette))) {
    recordFailure(
      failures,
      'tests-palette-mobile',
      'Mobile question palette screen missing',
      'The mobile flow should open a dedicated question palette state matching the Figma.',
      paletteShot,
    );
  }

  await clickFirstAvailable(page, [selectors.testsPaletteCloseMobile], [/close/i, /^x$/i, /back/i]);
  await sleep(400);
  await clickFirstAvailable(page, [selectors.testsExamSubmitMobile], [/submit test/i, /submit/i]);
  await sleep(800);

  const resultShot = await captureStep(page, ctx, captures, 'tests-result-mobile', 'tests-result-mobile');
  if (!(await page.$(selectors.testsResultMobile))) {
    recordFailure(
      failures,
      'tests-result-mobile',
      'Mobile test result screen missing',
      'After submitting, the mobile flow should show the result summary screen from the Figma.',
      resultShot,
    );
  }

  await waitForRankTransition(
    page,
    selectors.testsResultRankMobile,
    selectors.testsResultPercentileMobile,
    failures,
    'tests-result-rank-mobile',
    resultShot,
  );

  await clickFirstAvailable(page, [selectors.testsViewSolutions], [/view solutions/i, /view analysis/i, /solutions/i]);
  await sleep(700);
  const solutionsShot = await captureStep(page, ctx, captures, 'tests-solutions-mobile', 'tests-solutions-mobile');
  if (!(await page.$(selectors.testsSolutionsMobile))) {
    recordFailure(
      failures,
      'tests-solutions-mobile',
      'Mobile solutions screen missing',
      'The mobile flow should include the dedicated solutions and analysis screen after results.',
      solutionsShot,
    );
  }
};

export const runTestsReview = async (): Promise<{ captures: CaptureRecord[]; failures: FailureRecord[] }> => {
  const ctx = await createRunContext();
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];

  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  try {
    const desktopPage = await browser.newPage();
    await reviewDesktopFlow(desktopPage, ctx, captures, failures);
    await desktopPage.close();

    if (!skipMobileReview) {
      const mobilePage = await browser.newPage();
      await reviewMobileFlow(mobilePage, ctx, captures, failures);
      await mobilePage.close();
    }

    await writeJson(path.join(ctx.analysisDir, 'summary.json'), { captures, failures });
    await writeText(
      path.join(ctx.logDir, 'run.log'),
      `Run ${ctx.runId}\nCaptures: ${captures.length}\nFailures: ${failures.length}\n`,
    );

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `${failure.title}: ${failure.description}`).join('\n'));
    }

    return { captures, failures };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

if (process.argv[1]?.endsWith('tests-browser-review.ts')) {
  runTestsReview()
    .then((summary) => {
      console.log(`Tests review complete: ${summary.captures.length} captures, ${summary.failures.length} failures.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
