// @ts-check
/**
 * Visual demo test for Photo Parser front-end.
 *
 * Prerequisites:
 *   python app.py ./test_photos   (must be running on port 1976)
 *
 * Run:
 *   npx playwright test
 *   npx playwright test --headed        (watch the browser)
 *   npm run test:report                 (open HTML report)
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

// ─── selectors ──────────────────────────────────────────────────────────────
// Filter (funnel) toolbar button
const SEL_FILTER_BTN    = 'button:has(mat-icon:text("filter_list"))';
// Favorites-only toggle in toolbar (use title attribute to be unique vs the FAB)
const SEL_FAV_ONLY_BTN  = 'button[title="Show favorites only"]';
// Folder FAB (opens the main actions menu with Sort submenu)
const SEL_FOLDER_FAB    = 'button.folder-fab';
// Each thumbnail in the strip
const SEL_THUMB         = 'pp-image-strip .thumb';
// Favorite heart overlay on a thumbnail
const SEL_HEART         = 'pp-image-strip .selection-overlay';
// EXIF edit (pencil) button in info panel
const SEL_EXIF_EDIT     = 'pp-info-panel button[mattooltip="Edit basic fields"]';
// "No images found" empty state
const SEL_EMPTY         = 'pp-image-strip .empty';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Wait for the strip to stabilise after a filter/sort change. */
async function waitForStrip(page) {
  await page.waitForTimeout(500);
}

/** Count thumbnails currently shown in the strip. */
async function thumbCount(page) {
  const empty = page.locator(SEL_EMPTY);
  if (await empty.isVisible()) return 0;
  return page.locator(SEL_THUMB).count();
}

/** Return filenames in strip order (via alt attribute of the img inside each thumb). */
async function stripOrder(page) {
  return page.locator(`${SEL_THUMB} img[alt]`).evaluateAll(
    (imgs) => imgs.map((i) => i.alt),
  );
}

/** Open the Filter dialog via the toolbar filter button. */
async function openFilterDialog(page) {
  await page.locator(SEL_FILTER_BTN).click();
  await expect(page.getByRole('dialog', { name: 'Filter' })).toBeVisible();
}

/** Add a tag chip in the already-open Filter dialog (strips leading # automatically). */
async function addTagChip(page, tag) {
  const rawTag = tag.replace(/^#/, '');
  const input  = page.getByPlaceholder(/#hashtag/);
  await input.click();
  await input.fill(rawTag);
  await input.press('Enter');
  await expect(page.locator('mat-chip-row').filter({ hasText: rawTag })).toBeVisible();
}

/** Click Apply and wait for the dialog to close. */
async function applyFilter(page) {
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('dialog', { name: 'Filter' })).not.toBeVisible();
  await waitForStrip(page);
}

/** Click Reset and wait for the dialog to close. */
async function resetFilter(page) {
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByRole('dialog', { name: 'Filter' })).not.toBeVisible();
  await waitForStrip(page);
}

/**
 * Navigate the sort menu:
 *   folder-FAB → "Sort" submenu item → the option whose label matches `label`.
 */
async function selectSort(page, label) {
  await page.locator(SEL_FOLDER_FAB).click();
  await page.getByRole('menuitem', { name: 'Sort' }).click();
  await page.getByRole('menuitem', { name: label }).click();
  await waitForStrip(page);
}

/** Screenshot to tests/screenshots/<name>.png */
async function shot(page, name) {
  await page.screenshot({ path: `tests/screenshots/${name}.png` });
}

// ─── setup ──────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(`${SEL_THUMB} img[alt]`).first()).toBeVisible({ timeout: 15_000 });
  // Dismiss any leftover favorites from a previous run
  const fabHeart = page.locator('button[mat-fab]:has(mat-icon:text("favorite"))');
  if (await fabHeart.isVisible()) {
    await fabHeart.click();
    const clearBtn = page.getByRole('menuitem', { name: /clear favorites/i });
    if (await clearBtn.isVisible()) await clearBtn.click();
    await waitForStrip(page);
  }
  // Make sure no filter is active from a prior test
  // (each test suite starts fresh because the page is reloaded)
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('1 · Sorting', () => {

  test('Name A→Z  /  Z→A', async ({ page }) => {
    await shot(page, '01-sort-initial');

    // ── Name A→Z ────────────────────────────────────────────────────────────
    await selectSort(page, 'Name A→Z');
    const asc = await stripOrder(page);
    expect(asc.length).toBeGreaterThan(1);
    expect([...asc].sort((a, b) => a.localeCompare(b))).toEqual(asc);
    await shot(page, '02-sort-name-az');

    // ── Name Z→A ────────────────────────────────────────────────────────────
    await selectSort(page, 'Name Z→A');
    const desc = await stripOrder(page);
    expect([...desc].sort((a, b) => b.localeCompare(a))).toEqual(desc);
    await shot(page, '03-sort-name-za');

    // Z→A is the reverse of A→Z
    expect(desc).toEqual([...asc].reverse());
  });

  test('Newest first  /  Oldest first', async ({ page }) => {
    const total = await thumbCount(page);

    await selectSort(page, 'Newest first');
    await shot(page, '04-sort-newest-first');
    expect(await thumbCount(page)).toBe(total);

    await selectSort(page, 'Oldest first');
    await shot(page, '05-sort-oldest-first');
    const oldestOrder = await stripOrder(page);
    const newestOrder = await (async () => {
      await selectSort(page, 'Newest first');
      return stripOrder(page);
    })();
    // Oldest-first should be the reverse of newest-first
    expect(oldestOrder).toEqual([...newestOrder].reverse());
  });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('2 · Filtering', () => {

  test('file type — show .jpg only', async ({ page }) => {
    const totalBefore = await thumbCount(page);
    await shot(page, '06-filter-initial-all');

    await openFilterDialog(page);
    await shot(page, '07-filter-dialog-open');

    // Tick the .jpg checkbox
    await page.locator('mat-checkbox').filter({ hasText: '.jpg' }).click();
    await shot(page, '08-filter-jpg-ticked');
    await applyFilter(page);
    await shot(page, '09-filter-jpg-result');

    const afterCount = await thumbCount(page);
    expect(afterCount).toBeGreaterThan(0);
    expect(afterCount).toBeLessThan(totalBefore);

    // Every visible filename ends with .jpg
    const names = await stripOrder(page);
    for (const n of names) expect(n.toLowerCase()).toMatch(/\.jpg$/);

    // Reset restores all photos
    await openFilterDialog(page);
    await resetFilter(page);
    await shot(page, '10-filter-reset-restored');
    expect(await thumbCount(page)).toBe(totalBefore);
  });

  test('file size — minimum 10 000 KB (≈10 MB)', async ({ page }) => {
    const totalBefore = await thumbCount(page);

    await openFilterDialog(page);
    await page.getByRole('spinbutton', { name: /min.*kb/i }).fill('10000');
    await shot(page, '11-filter-size-min-10mb');
    await applyFilter(page);
    await shot(page, '12-filter-size-result');

    const afterCount = await thumbCount(page);
    expect(afterCount).toBeGreaterThan(0);
    expect(afterCount).toBeLessThan(totalBefore);

    // Reset
    await openFilterDialog(page);
    await resetFilter(page);
    expect(await thumbCount(page)).toBe(totalBefore);
  });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('3 · Favorites', () => {

  test('mark 2 photos, show favorites-only, clear', async ({ page }) => {
    const total = await thumbCount(page);
    await shot(page, '13-favorites-initial');

    // ── Mark first two thumbnails as favorites ───────────────────────────────
    await page.locator(SEL_HEART).nth(0).click({ force: true });
    await page.waitForTimeout(200);
    await page.locator(SEL_HEART).nth(1).click({ force: true });
    await page.waitForTimeout(200);
    await shot(page, '14-two-hearts-clicked');

    // Confirm the favorites FAB appeared
    const favFab = page.locator('button[mat-fab]:has(mat-icon:text("favorite"))');
    await expect(favFab).toBeVisible();
    const badge = page.locator('.favorites-count');
    await expect(badge).toHaveText('2');
    await shot(page, '15-favorites-fab-badge-2');

    // ── Show favorites only ─────────────────────────────────────────────────
    await page.locator(SEL_FAV_ONLY_BTN).click();
    await waitForStrip(page);
    await shot(page, '16-favorites-only-view');

    const favCount = await thumbCount(page);
    expect(favCount).toBe(2);

    // All visible photos are favorited (strip shows only favorited thumbs)
    const favThumbs = await page.locator(`${SEL_THUMB}.favorited`).count();
    expect(favThumbs).toBe(2);

    // ── Turn off favorites-only filter ──────────────────────────────────────
    await page.locator(SEL_FAV_ONLY_BTN).click();
    await waitForStrip(page);
    await shot(page, '17-favorites-filter-off-all-back');
    expect(await thumbCount(page)).toBe(total);

    // ── Clear favorites via FAB menu ────────────────────────────────────────
    await favFab.click();
    await page.getByRole('menuitem', { name: /clear favorites/i }).click();
    await page.waitForTimeout(300);
    await shot(page, '18-favorites-cleared');
    await expect(favFab).not.toBeVisible();
  });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('4 · Edit tags + filter by tag', () => {

  test('write a unique #tag via EXIF edit dialog, then filter and find exactly that photo', async ({ page }) => {
    const UNIQUE_TAG = 'demotag99';
    const total = await thumbCount(page);

    // ── 1. Verify the tag produces 0 results before we write it ─────────────
    await openFilterDialog(page);
    await addTagChip(page, UNIQUE_TAG);
    await applyFilter(page);
    await shot(page, '19-tag-filter-before-edit');
    expect(await thumbCount(page)).toBe(0);
    await expect(page.locator(SEL_EMPTY)).toBeVisible();

    await openFilterDialog(page);
    await resetFilter(page);
    expect(await thumbCount(page)).toBe(total);

    // ── 2. Select the first photo and open its EXIF edit dialog ─────────────
    const firstThumb = page.locator(`${SEL_THUMB} img[alt]`).first();
    const targetName = await firstThumb.getAttribute('alt');
    await firstThumb.click();
    await page.waitForTimeout(300);
    await shot(page, '20-first-photo-selected');

    const editBtn = page.locator(SEL_EXIF_EDIT);
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, '21-exif-edit-dialog-open');

    // ── 3. Write the unique tag into "Comments and tags" field ───────────────
    const commentField = page.getByLabel(/comments and tags/i);
    await commentField.clear();
    await commentField.fill(`Demo photo #${UNIQUE_TAG} #playwright`);
    await shot(page, '22-unique-tag-entered');

    // ── 4. Save — wait for the button to be enabled (dialog finishes loading) ─
    const saveBtn = page.getByRole('button', { name: 'Save' });
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    await saveBtn.click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await shot(page, '23-edit-saved');

    // ── 5. Filter by the unique tag — expect exactly 1 result ───────────────
    await openFilterDialog(page);
    await addTagChip(page, UNIQUE_TAG);
    await shot(page, '24-filter-by-new-tag');
    await applyFilter(page);
    await shot(page, '24-filter-by-new-tag-set');

    expect(await thumbCount(page)).toBe(1);

    const visibleName = await page.locator(`${SEL_THUMB} img[alt]`).first().getAttribute('alt');
    expect(visibleName).toBe(targetName);
    await shot(page, '25-exactly-one-photo-found');

    // ── 6. Reset and verify all photos are back ──────────────────────────────
    await openFilterDialog(page);
    await resetFilter(page);
    await shot(page, '26-final-all-photos-restored');
    expect(await thumbCount(page)).toBe(total);
  });
});
