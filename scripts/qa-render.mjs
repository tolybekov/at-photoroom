const playwrightImport = process.env.PLAYWRIGHT_IMPORT || "playwright";
const baseUrl = process.env.BASE_URL || "http://localhost:4173";
const { chromium } = await import(playwrightImport);

const browser = await chromium.launch({ headless: true });
const results = [];

try {
  results.push(await checkViewport("desktop", { width: 1440, height: 1000 }, true));
  results.push(await checkViewport("mobile", { width: 390, height: 844 }, false));
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));

async function checkViewport(name, viewport, clickPhoto) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const logs = [];
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1800);

  if (clickPhoto) {
    await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
    await page.waitForTimeout(800);
  }

  const state = await page.evaluate(() => {
    const canvas = document.querySelector("#room-canvas");
    const brand = document.querySelector(".brand").getBoundingClientRect();
    const owner = document.querySelector("#owner-button").getBoundingClientRect();
    const focus = document.querySelector("#focus-bar").getBoundingClientRect();
    const focusStyle = getComputedStyle(document.querySelector("#focus-bar"));
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const sample = readCanvasSample(gl);

    return {
      title: document.title,
      count: document.querySelector("#photo-count").textContent,
      canvas: roundedRect(canvas.getBoundingClientRect()),
      brand: roundedRect(brand),
      owner: roundedRect(owner),
      focus: {
        ...roundedRect(focus),
        opacity: Number(focusStyle.opacity),
        visibility: focusStyle.visibility
      },
      sample
    };

    function roundedRect(rect) {
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    }

    function readCanvasSample(context) {
      if (!context) {
        return { available: false, uniqueColors: 0, nonPaper: 0 };
      }

      const width = context.drawingBufferWidth;
      const height = context.drawingBufferHeight;
      const pixels = new Uint8Array(4 * 400);
      context.readPixels(
        Math.floor(width / 2) - 10,
        Math.floor(height / 2) - 10,
        20,
        20,
        context.RGBA,
        context.UNSIGNED_BYTE,
        pixels
      );

      const unique = new Set();
      let nonPaper = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        unique.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]},${pixels[index + 3]}`);
        if (!(pixels[index] > 235 && pixels[index + 1] > 235 && pixels[index + 2] > 230)) {
          nonPaper += 1;
        }
      }

      return { available: true, uniqueColors: unique.size, nonPaper };
    }
  });

  await page.screenshot({ path: `/private/tmp/at-photoroom-${name}.png`, fullPage: true });
  await page.close();
  return { name, state, logs };
}
