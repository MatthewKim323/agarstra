import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { ComputerAction } from "../shared/types";
import { VIEWPORT, normalizeKeys, describeAction } from "./actions";
import { AppError } from "./errors";
import type { LabState } from "./lab";
import { isAllowedRequest, type NetworkPolicy } from "./security";

export type BrowserSnapshot = {
  screenshot: string;
  url: string;
  title: string;
  width: number;
  height: number;
};
export interface ComputerBrowser {
  open(url: string, policy: NetworkPolicy, signal: AbortSignal): Promise<void>;
  snapshot(): Promise<BrowserSnapshot>;
  perform(action: ComputerAction, signal: AbortSignal): Promise<void>;
  pointFor(selector: string): Promise<{ x: number; y: number }>;
  describe(
    actions: ComputerAction[],
  ): Promise<{ summary: string; warnings: string[] }>;
  labState(): Promise<LabState>;
  close(): Promise<void>;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("Operation cancelled", "AbortError");
}

export class PlaywrightComputer implements ComputerBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private policy: NetworkPolicy | null = null;

  private current(): Page {
    if (!this.page || this.page.isClosed())
      throw new AppError(409, "Start a browser session first.");
    return this.page;
  }

  async open(
    url: string,
    policy: NetworkPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    assertActive(signal);
    await this.close();
    this.policy = policy;
    const args = [
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ];
    if (policy.pinnedAddress && !policy.local) {
      const address = policy.pinnedAddress.includes(":")
        ? `[${policy.pinnedAddress}]`
        : policy.pinnedAddress;
      args.push(
        `--host-resolver-rules=MAP ${policy.hostname} ${address}, MAP * ~NOTFOUND`,
        "--disable-features=DnsOverHttps",
      );
    }
    try {
      this.browser = await chromium.launch({ headless: true, args });
    } catch {
      throw new AppError(
        503,
        "Chromium is not available. Run npm run setup, then restart Nerve.",
      );
    }
    if (signal.aborted) {
      await this.close();
      assertActive(signal);
    }
    this.context = await this.browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
    });
    this.context.setDefaultTimeout(4000);
    this.context.setDefaultNavigationTimeout(12000);
    await this.context.route("**/*", async (route) => {
      if (isAllowedRequest(route.request().url(), policy))
        await route.continue().catch(() => {});
      else await route.abort("blockedbyclient").catch(() => {});
    });
    await this.context.routeWebSocket("**/*", (socket) => socket.close());
    this.page = await this.context.newPage();
    const primary = this.page;
    this.context.on("page", (page) => {
      if (page !== primary) void page.close().catch(() => {});
    });
    this.page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    this.page.on(
      "download",
      (download) => void download.cancel().catch(() => {}),
    );
    const abortOpen = () => void primary.close().catch(() => {});
    signal.addEventListener("abort", abortOpen, { once: true });
    try {
      await primary.goto(url, { waitUntil: "domcontentloaded" });
      assertActive(signal);
      await primary.waitForTimeout(120);
    } catch (error) {
      assertActive(signal);
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        "This page could not be opened inside the restricted browser. Third-party resources and redirects to other sites are blocked.",
      );
    } finally {
      signal.removeEventListener("abort", abortOpen);
    }
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = this.current();
    const url = page.url();
    if (!this.policy || !isAllowedRequest(url, this.policy))
      throw new AppError(
        403,
        "The browser left its approved website. Reset the session.",
      );
    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      timeout: 5000,
    });
    return {
      screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
      url,
      title: (await page.title()).slice(0, 160),
      ...VIEWPORT,
    };
  }

  async perform(action: ComputerAction, signal: AbortSignal): Promise<void> {
    assertActive(signal);
    const page = this.current();
    if (!this.policy || !isAllowedRequest(page.url(), this.policy))
      throw new AppError(
        403,
        "The browser is no longer on its approved website.",
      );
    switch (action.type) {
      case "click":
        await page.mouse.click(action.x!, action.y!);
        break;
      case "double_click":
        await page.mouse.dblclick(action.x!, action.y!);
        break;
      case "move":
        await page.mouse.move(action.x!, action.y!);
        break;
      case "scroll":
        await page.mouse.move(action.x!, action.y!);
        assertActive(signal);
        await page.mouse.wheel(action.scroll_x!, action.scroll_y!);
        break;
      case "type":
        await page.keyboard.insertText(action.text!);
        break;
      case "keypress": {
        const keys = normalizeKeys(action.keys!);
        const held: string[] = [];
        try {
          for (const key of keys.slice(0, -1)) {
            assertActive(signal);
            await page.keyboard.down(key);
            held.push(key);
          }
          assertActive(signal);
          await page.keyboard.press(keys[keys.length - 1]);
        } finally {
          for (const key of held.reverse())
            await page.keyboard.up(key).catch(() => {});
        }
        break;
      }
      case "drag": {
        const path = action.path!;
        await page.mouse.move(path[0].x, path[0].y);
        assertActive(signal);
        await page.mouse.down();
        try {
          for (const point of path.slice(1)) {
            assertActive(signal);
            await page.mouse.move(point.x, point.y);
          }
        } finally {
          await page.mouse.up().catch(() => {});
        }
        break;
      }
      case "wait":
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener("abort", cancel);
            resolve();
          };
          const timer = setTimeout(done, 300);
          const cancel = () => {
            clearTimeout(timer);
            reject(new DOMException("Operation cancelled", "AbortError"));
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
        break;
      case "screenshot":
        break;
    }
    assertActive(signal);
    // Let event handlers render before the next independently captured observation.
    if (action.type !== "screenshot") await page.waitForTimeout(75);
    assertActive(signal);
  }

  async pointFor(selector: string): Promise<{ x: number; y: number }> {
    const target = this.current().locator(selector);
    const box = await target.boundingBox({ timeout: 3000 });
    if (!box)
      throw new AppError(
        409,
        "The expected practice control is not visible. Reset the session and try again.",
      );
    const x = Math.round(box.x + box.width / 2),
      y = Math.round(box.y + box.height / 2);
    if (x < 0 || y < 0 || x >= VIEWPORT.width || y >= VIEWPORT.height)
      throw new AppError(
        409,
        "The practice control is outside the viewport. Reset the session.",
      );
    return { x, y };
  }

  async describe(
    actions: ComputerAction[],
  ): Promise<{ summary: string; warnings: string[] }> {
    const descriptions: string[] = [],
      warnings = new Set<string>();
    for (const action of actions) {
      if (action.type === "click" || action.type === "double_click") {
        const label = await this.current().evaluate(
          ({ x, y }) => {
            const element = document
              .elementFromPoint(x, y)
              ?.closest('button,a,input,textarea,[role="button"]');
            return (
              element?.getAttribute("aria-label") ||
              element?.textContent ||
              element?.getAttribute("placeholder") ||
              ""
            )
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 90);
          },
          { x: action.x!, y: action.y! },
        );
        descriptions.push(label ? `Click “${label}”.` : describeAction(action));
        if (
          /send|delete|remove|purchase|buy|pay|submit|publish|upload|confirm|transfer/i.test(
            label,
          )
        )
          warnings.add(
            "This control may send information or make a consequential change. Check the target and the current screen before approving.",
          );
      } else descriptions.push(describeAction(action));
      if (action.type === "type" && !this.policy?.local)
        warnings.add(
          "Typing into an external website can transmit this text before a form is submitted.",
        );
      if (
        action.type === "keypress" &&
        action.keys?.some((key) => /^(enter|return)$/i.test(key))
      )
        warnings.add(
          "Enter can submit the focused form. Check the focused control before approving.",
        );
    }
    return { summary: descriptions.join(" "), warnings: [...warnings] };
  }

  async labState(): Promise<LabState> {
    if (!this.policy?.local)
      throw new AppError(
        409,
        "Practice workspace diagnostics are only available in the local lab.",
      );
    return this.current().evaluate(() => {
      const stored = localStorage.getItem("nerve-practice-v1");
      if (!stored) throw new Error("Practice workspace is not ready");
      return JSON.parse(stored);
    }) as Promise<LabState>;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    this.policy = null;
    if (browser) await browser.close().catch(() => {});
  }
}
