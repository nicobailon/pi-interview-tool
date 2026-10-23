// npm run test:browser — synthetic ClipboardEvents in a real headless browser.
// No OS clipboard/display access. Playwright/Chromium are optional, never downloaded.
// Use INTERVIEW_PLAYWRIGHT_MODULE and INTERVIEW_CHROMIUM to reuse local installations.
import assert from "node:assert/strict";
import { after, before, test as nodeTest } from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const modulePath = process.env.INTERVIEW_PLAYWRIGHT_MODULE || "playwright";
let chromium;
let unavailable;
try {
  ({ chromium } = await import(modulePath));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  unavailable = "Playwright unavailable: install separately or set INTERVIEW_PLAYWRIGHT_MODULE";
}
const executablePath = process.env.INTERVIEW_CHROMIUM || chromium?.executablePath();
if (!unavailable && !existsSync(executablePath)) {
  unavailable = "Chromium unavailable: set INTERVIEW_CHROMIUM to an existing browser executable";
}
const test = (name, run) => nodeTest(name, { skip: unavailable || false }, run);
let browser;
before(async () => {
  if (!unavailable) browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });

const questions = [
  ...Array.from({ length: 13 }, (_, i) => ({ id: `q${i}`, type: "text", question: `Question ${i}` })),
  { id: "photo", type: "image", question: "Image" },
  { id: "choice", type: "single", question: "Choice", options: ["Yes"] },
  { id: "info", type: "info", question: "Information only" },
];
const card = (id) => `.question-card[data-question-id="${id}"]`;
const drop = (id) => `${card(id)} .attach-inline-drop`;
const names = (id) => `${card(id)} .selected-image .selected-item-name`;
const error = (id) => `[data-error-for="${id}"]`;

async function fixture(run) {
  const template = await readFile(new URL("../form/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../form/script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../form/styles.css", import.meta.url), "utf8");
  const submissions = [];
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/submit") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submissions.push(JSON.parse(Buffer.concat(chunks).toString()));
    }
    const data = { questions, sessionToken: "fixture", timeout: 0, autoSaveOnSubmit: false };
    const body = pathname === "/" ? template.replace("/* __INTERVIEW_DATA_PLACEHOLDER__ */", JSON.stringify(data))
      : pathname === "/script.js" ? script : pathname.endsWith(".css") ? css
      : JSON.stringify({ ok: true, sessions: [] });
    res.setHeader("Content-Type", pathname === "/" ? "text/html" : pathname.endsWith(".js") ? "text/javascript"
      : pathname.endsWith(".css") ? "text/css" : "application/json");
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  // Any attempted background/shortcut clipboard access fails the test.
  await page.addInitScript(() => {
    window.clipboardReads = 0;
    Object.defineProperty(navigator, "clipboard", { value: {
      read: () => { window.clipboardReads++; throw new Error("Unexpected clipboard read"); },
      readText: () => { window.clipboardReads++; throw new Error("Unexpected clipboard readText"); },
    } });
  });
  try {
    await page.goto(origin);
    // Navigation intentionally assigns initial focus on a 100ms timer. Wait for
    // that observable state, not just rendered cards, before simulating user input.
    await page.waitForFunction(() => document.activeElement?.matches('textarea[data-question-id="q0"]'));
    await run(page, submissions);
    assert.equal(await page.evaluate(() => window.clipboardReads), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function openAttach(page, id) {
  await page.locator(`${card(id)} .attach-btn`).click();
  assert.equal(await page.locator(drop(id)).evaluate((el) => el === document.activeElement), true);
}

// Dispatch on a real focused DOM element, with real browser File/DataTransfer items.
async function paste(page, selector, options = {}) {
  return page.locator(selector).evaluate(async (target, opts) => {
    const clipboard = new DataTransfer();
    if (opts.text !== undefined) clipboard.setData("text/plain", opts.text);
    for (const spec of opts.files || []) {
      const type = spec.type || "image/png";
      let blob;
      if (spec.corrupt) blob = new Blob(["not an image"], { type });
      else if (type === "image/svg+xml") blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type });
      else if (type === "image/gif") {
        const bytes = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
        blob = new Blob([bytes], { type });
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = spec.width || 2;
        canvas.height = spec.height || 2;
        canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, type));
      }
      if (spec.size) blob = new Blob([blob, new Uint8Array(spec.size - blob.size)], { type });
      clipboard.items.add(new File([blob], spec.name || "screenshot.png", { type }));
    }
    const event = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
    // Exercise the files-only compatibility fallback as well.
    if (opts.filesOnly) Object.defineProperty(event, "clipboardData", { value: { items: [], files: clipboard.files, getData: () => "" } });
    if (!opts.keepFocus) target.focus();
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, options);
}

async function waitFor(check) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail("Timed out waiting for browser state");
}
async function expectNames(page, id, expected) {
  await waitFor(async () => JSON.stringify(await page.locator(names(id)).allTextContents()) === JSON.stringify(expected));
}
async function expectError(page, id, expected) {
  await waitFor(async () => (await page.locator(error(id)).textContent()).includes(expected));
}

// A fresh page per test avoids progress/storage/state leakage between cases.
async function shortcut(page, key) {
  const modifier = await page.evaluate(() => navigator.platform.toUpperCase().includes("MAC") ? "Meta" : "Control");
  await page.keyboard.press(`${modifier}+${key}`);
}

test("+Attach targets the focused question, not navigation state; direct button and files-only paste work", async () => fixture(async (page) => {
  await openAttach(page, "q4");
  assert.equal(await paste(page, drop("q4"), { files: [{ name: "four.png" }] }), true);
  await expectNames(page, "q4", ["four.png"]);
  await expectNames(page, "q0", []);
  assert.equal(await paste(page, `${card("q2")} .attach-btn`, { filesOnly: true, files: [{ name: "two.png" }] }), true);
  await expectNames(page, "q2", ["two.png"]);
  assert.equal(await page.locator(`${card("q2")} .attach-inline`).isVisible(), true);
  // Ordinary noncurrent card/textarea clicks still activate and focus the textarea.
  await page.locator(`${card("q7")} .question-title`).click();
  assert.equal(await page.locator(`${card("q7")} textarea`).evaluate((el) => el === document.activeElement), true);
  await page.locator(`${card("q8")} textarea`).click();
  assert.equal(await page.locator(`${card("q8")} textarea`).evaluate((el) => el === document.activeElement), true);
  // Re-entering a noncurrent +Attach from Submit must clear submit navigation
  // state without stealing attachment focus or disabling question shortcuts.
  await page.locator(`${card("photo")} .question-title`).click();
  await shortcut(page, "ArrowRight");
  await shortcut(page, "ArrowRight");
  assert.equal(await page.locator("#submit-btn").evaluate((el) => el === document.activeElement), true);
  await openAttach(page, "q6");
  assert.equal(await page.locator(".form-footer").evaluate((el) => el.classList.contains("active")), false);
  await shortcut(page, "ArrowRight");
  assert.equal(await page.locator(`${card("q7")} textarea`).evaluate((el) => el === document.activeElement), true);
}));

test("text and mixed clipboards preserve selection replacement/input events without attaching", async () => fixture(async (page) => {
  const text = `${card("q0")} textarea`;
  await page.locator(text).fill("before SELECT after");
  await page.locator(text).evaluate((el) => { el.setSelectionRange(7, 13); window.inputs = 0; el.addEventListener("input", () => window.inputs++); });
  assert.equal(await paste(page, text, { text: "PASTE", files: [{ name: "ignored.png" }] }), true);
  assert.equal(await page.locator(text).inputValue(), "before PASTE after");
  assert.equal(await page.locator(text).evaluate((el) => el.selectionStart), 12);
  assert.equal(await page.evaluate(() => window.inputs), 1);
  await expectNames(page, "q0", []);
  await openAttach(page, "q0");
  for (const value of ["plain", " ", "\n"]) {
    assert.equal(await paste(page, drop("q0"), { text: value, files: [{}] }), false);
    await expectNames(page, "q0", []);
  }
  const path = `${card("q0")} .attach-inline-path`;
  await page.locator(path).fill("abcdef");
  await page.locator(path).evaluate((el) => el.setSelectionRange(2, 4));
  assert.equal(await paste(page, path, { text: "XY", files: [{}] }), true);
  assert.equal(await page.locator(path).inputValue(), "abXYef");
  const other = `${card("choice")} .other-input`;
  await page.locator(other).fill("ab");
  assert.equal(await paste(page, other, { text: "CD" }), true);
  assert.equal(await page.locator(other).inputValue(), "abCD");
}));

test("unrelated focus, text controls, info cards and mismatched event targets cannot receive images", async () => fixture(async (page) => {
  await openAttach(page, "q0");
  for (const selector of ["#submit-btn", `${card("q1")} textarea`, `${card("q0")} .attach-inline-path`, card("info")]) {
    assert.equal(await paste(page, selector, { files: [{}] }), false);
  }
  await page.locator("#submit-btn").focus();
  assert.equal(await paste(page, drop("q0"), { keepFocus: true, files: [{}] }), false);
  await page.locator(drop("q0")).focus();
  assert.equal(await paste(page, `${card("q1")} .attach-btn`, { keepFocus: true, files: [{}] }), false);
  await shortcut(page, "v"); // No shortcut-based reads/attachment.
  assert.equal(await page.locator(".selected-image").count(), 0);
}));

test("PNG/JPEG/GIF/WebP, first-image-only replacement, invalid MIME/size/decode/dimensions and inclusive limits", async () => fixture(async (page) => {
  await openAttach(page, "q0");
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const name = `valid.${type.split("/")[1]}`;
    await paste(page, drop("q0"), { files: [{ type, name }, { name: "second.png" }] });
    await expectNames(page, "q0", [name]);
  }
  const invalid = [
    [{ type: "image/svg+xml" }, "Invalid file type"],
    [{ size: 5 * 1024 * 1024 + 1 }, "5MB"],
    [{ corrupt: true }, "Failed to load image"],
    [{ width: 4097 }, "4096x4096"],
    [{ height: 4097 }, "4096x4096"],
  ];
  for (const [spec, message] of invalid) {
    await paste(page, drop("q0"), { files: [spec] });
    await expectError(page, "q0", message);
    await expectNames(page, "q0", ["valid.webp"]);
  }
  await paste(page, drop("q0"), { files: [{ name: "boundary.png", width: 4096, height: 4096, size: 5 * 1024 * 1024 }] });
  await expectNames(page, "q0", ["boundary.png"]);
  assert.equal(await page.locator(error("q0")).textContent(), "");
}));

test("12-upload count limit, replacement at capacity, removal frees a slot and image-question targeting", async () => fixture(async (page) => {
  for (let i = 0; i < 12; i++) {
    await paste(page, `${card(`q${i}`)} .attach-btn`, { files: [{ name: `${i}.png` }] });
    await expectNames(page, `q${i}`, [`${i}.png`]);
  }
  await paste(page, `${card("q12")} .attach-btn`, { files: [{}] });
  await expectError(page, "q12", "Only 12 images");
  await expectNames(page, "q12", []);
  await paste(page, drop("q0"), { files: [{ name: "replacement.png" }] });
  await expectNames(page, "q0", ["replacement.png"]);
  await page.locator(`${card("q1")} .selected-item-remove`).click();
  await paste(page, `${card("photo")} .file-dropzone`, { files: [{ name: "photo.png" }] });
  await expectNames(page, "photo", ["photo.png"]);
  assert.equal(await page.locator(".selected-image").count(), 12);
}));

test("submission uses ordinary one-file-per-question replacement payload and preserves existing path attachments", async () => fixture(async (page, submissions) => {
  await openAttach(page, "q3");
  const path = `${card("q3")} .attach-inline-path`;
  await page.locator(path).fill("/existing/path.png");
  await page.locator(path).press("Enter");
  assert.equal(await paste(page, drop("q3"), { text: "", files: [{ name: "old.png" }] }), true);
  await expectNames(page, "q3", ["old.png"]);
  await paste(page, drop("q3"), { files: [{ name: "new.png" }] });
  await expectNames(page, "q3", ["new.png"]);
  await paste(page, `${card("photo")} .file-dropzone`, { files: [{ name: "image.png" }] });
  await expectNames(page, "photo", ["image.png"]);
  await page.locator("#submit-btn").click();
  await waitFor(() => submissions.length === 1);
  const payload = submissions[0];
  assert.equal(payload.token, "fixture");
  assert.equal(payload.images.length, 2);
  assert.deepEqual(payload.images.map(({ id, mimeType, isAttachment }) => ({ id, mimeType, isAttachment })), [
    { id: "q3", mimeType: "image/png", isAttachment: true },
    { id: "photo", mimeType: "image/png", isAttachment: undefined },
  ]);
  assert.ok(payload.images.every((image) => /^pasted-[\da-f-]+\.png$/.test(image.filename)));
  assert.equal(Buffer.from(payload.images[0].data, "base64").subarray(1, 4).toString(), "PNG");
  assert.deepEqual(payload.responses.find((item) => item.id === "q3").attachments, ["/existing/path.png"]);
}));

test("same-name screenshots retain their visible names but receive distinct upload filenames", async () => fixture(async (page, submissions) => {
  await paste(page, `${card("q0")} .attach-btn`, { files: [{ name: "image.png", width: 2 }] });
  await expectNames(page, "q0", ["image.png"]);
  await paste(page, `${card("q1")} .attach-btn`, { files: [{ name: "image.png", width: 3 }] });
  await expectNames(page, "q1", ["image.png"]);
  await page.locator("#submit-btn").click();
  await waitFor(() => submissions.length === 1);
  const images = submissions[0].images;
  assert.deepEqual(images.map((image) => image.id), ["q0", "q1"]);
  assert.notEqual(images[0].data, images[1].data);
  assert.notEqual(images[0].filename, images[1].filename);
  assert.ok(images.every((image) => /^pasted-[\da-f-]+\.png$/.test(image.filename)));
}));
