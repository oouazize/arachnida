/**
 * spider - recursively download images from a website.
 *
 * Usage: ./spider [-r] [-l N] [-p PATH] URL
 *
 * Only Node.js built-ins are used:
 *   - fetch()   -> send HTTP requests (allowed by the subject)
 *   - node:fs   -> write files
 * HTML tokenizing, crawling, link resolution, filtering and downloading are
 * our own code. Pages and images are fetched concurrently (with a limit) so
 * the crawl is much faster than downloading one file at a time.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFAULT_DEPTH = 5;
const DEFAULT_PATH = "./data/";
const EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp"];
const USER_AGENT = "Mozilla/5.0 (compatible; arachnida-spider/1.0)";
const TIMEOUT_MS = 10_000;
const MAX_PAGE_SIZE = 10 * 1024 * 1024; // don't parse HTML pages > 10 MB
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // don't download images > 50 MB
const PAGE_CONCURRENCY = 8; // pages fetched at the same time
const IMAGE_CONCURRENCY = 16; // images downloaded at the same time

// First bytes ("magic numbers") of each supported format. Used to make sure
// that what we saved is really an image and not an HTML error page.
const MAGIC: [Buffer, string][] = [
  [Buffer.from([0xff, 0xd8, 0xff]), "jpg"],
  [Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), "png"],
  [Buffer.from("GIF87a"), "gif"],
  [Buffer.from("GIF89a"), "gif"],
  [Buffer.from("BM"), "bmp"],
];

// ------------------------------------------------------------------------- //
// HTML tokenizing
// ------------------------------------------------------------------------- //
interface Extracted {
  images: string[];
  links: string[];
  base: string | null;
}

// A start tag: "<name" followed by anything except ">", where quoted values
// may contain ">" (e.g. alt="a > b").
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
// One attribute: name, or name=value with "double", 'single' or bare value.
const ATTR_RE = /([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? m;
  });
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

/** 'a.jpg 1x, b.jpg 2x' -> ['a.jpg', 'b.jpg'] */
function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Collect image URLs and page links found in an HTML document. */
function extract(html: string): Extracted {
  const out: Extracted = { images: [], links: [], base: null };
  // Comments and <script>/<style> bodies are not markup: remove them first so
  // that a "<img" written inside JavaScript is not mistaken for a tag.
  html = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  for (const m of html.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    const a = parseAttributes(m[2]);
    const get = (k: string) => a.get(k) || "";

    if (tag === "base" && get("href") && out.base === null) {
      out.base = get("href");
    } else if (tag === "img") {
      for (const k of ["src", "data-src", "data-original", "data-lazy-src"]) {
        if (get(k)) out.images.push(get(k));
      }
      if (get("srcset")) out.images.push(...parseSrcset(get("srcset")));
    } else if (tag === "source" && get("srcset")) {
      out.images.push(...parseSrcset(get("srcset"))); // <picture><source>
    } else if ((tag === "a" || tag === "area") && get("href")) {
      out.links.push(get("href")); // may be an image or another page
    } else if (tag === "link" && get("href")) {
      const rel = get("rel").toLowerCase();
      if (rel.includes("icon") || rel.includes("image_src")) out.images.push(get("href"));
    } else if (tag === "meta" && get("content")) {
      const prop = (get("property") || get("name")).toLowerCase();
      if (prop === "og:image" || prop === "twitter:image") out.images.push(get("content"));
    }
  }
  return out;
}

// ------------------------------------------------------------------------- //
// URL helpers
// ------------------------------------------------------------------------- //
/** Resolve a (possibly relative) URL against base and drop the #fragment. */
function normalize(raw: string, base: string): string | null {
  const url = raw.trim();
  if (!url || /^(javascript|mailto|tel|data):/i.test(url)) return null;
  try {
    const u = new URL(url, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function hasImageExtension(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Only crawl pages on the same host as the starting URL. */
function sameSite(url: string, root: string): boolean {
  return new URL(url).host === new URL(root).host;
}

// ------------------------------------------------------------------------- //
// Concurrency limiter: at most `max` tasks run at the same time
// ------------------------------------------------------------------------- //
class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand our slot directly to the next waiting task, if any.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

// ------------------------------------------------------------------------- //
// Networking
// ------------------------------------------------------------------------- //
function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause as { code?: string; message?: string } | undefined;
    if (e.name === "TimeoutError") return "timed out";
    return cause?.code ?? cause?.message ?? e.message;
  }
  return String(e);
}

async function request(url: string): Promise<Response> {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  return resp;
}

/** Read the body but stop as soon as it exceeds maxSize. */
async function readBody(resp: Response, maxSize: number): Promise<Buffer> {
  if (Number(resp.headers.get("content-length")) > maxSize) {
    await resp.body?.cancel();
    throw new Error("response too large");
  }
  if (!resp.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of resp.body) {
    total += chunk.length;
    if (total > maxSize) throw new Error("response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeHtml(body: Buffer, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1].trim() || "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

// ------------------------------------------------------------------------- //
// Saving images
// ------------------------------------------------------------------------- //
function detectFormat(data: Buffer): string | null {
  for (const [magic, fmt] of MAGIC) {
    if (data.subarray(0, magic.length).equals(magic)) return fmt;
  }
  return null;
}

// ------------------------------------------------------------------------- //
// Crawler
// ------------------------------------------------------------------------- //
class Spider {
  private readonly visitedPages = new Set<string>();
  private readonly seenImages = new Set<string>();
  private readonly claimedPaths = new Set<string>();
  private readonly pageLimiter = new Limiter(PAGE_CONCURRENCY);
  private readonly imageLimiter = new Limiter(IMAGE_CONCURRENCY);
  private readonly downloads: Promise<void>[] = [];
  private readonly start: string;
  private root: string; // start URL after redirects, defines "same site"
  private readonly maxDepth: number;
  private readonly dest: string;
  downloaded = 0;

  constructor(start: string, maxDepth: number, dest: string) {
    this.start = start;
    this.root = start;
    this.maxDepth = maxDepth;
    this.dest = dest;
  }

  /**
   * Level-by-level (breadth-first) crawl.
   *   depth 0 = the start page itself
   *   depth N = pages reached by following N links from the start page
   * All pages of one level are fetched concurrently; images start
   * downloading as soon as they are found, in parallel with page fetching.
   */
  async crawl(): Promise<number> {
    let level = [this.start];
    for (let depth = 0; level.length > 0 && depth <= this.maxDepth; depth++) {
      const next: string[] = [];
      await Promise.all(
        level.map((url) => this.pageLimiter.run(() => this.visit(url, depth, next))),
      );
      level = [...new Set(next)].filter((u) => !this.visitedPages.has(u));
    }
    await Promise.all(this.downloads);
    return this.visitedPages.size;
  }

  private async visit(url: string, depth: number, next: string[]): Promise<void> {
    if (this.visitedPages.has(url)) return;
    this.visitedPages.add(url);

    // The URL given on the command line may itself be an image.
    if (hasImageExtension(url)) {
      this.queueImage(url);
      return;
    }

    let finalUrl: string;
    let html: string;
    try {
      const resp = await request(url);
      const ctype = (resp.headers.get("content-type") ?? "").toLowerCase();
      if (!ctype.includes("html")) {
        await resp.body?.cancel();
        return;
      }
      finalUrl = resp.url || url;
      html = decodeHtml(await readBody(resp, MAX_PAGE_SIZE), ctype);
    } catch (e) {
      console.error(`[!] page   ${url}: ${errorMessage(e)}`);
      return;
    }
    this.visitedPages.add(finalUrl); // after redirects
    // example.com may redirect to www.example.com: follow links on the new host
    if (url === this.start) this.root = finalUrl;
    console.log(`[*] depth ${depth}: ${finalUrl}`);

    const found = extract(html);
    const base = (found.base && normalize(found.base, finalUrl)) || finalUrl;

    for (const raw of found.images) {
      const img = normalize(raw, base);
      if (img && hasImageExtension(img)) this.queueImage(img);
    }
    for (const raw of found.links) {
      const link = normalize(raw, base);
      if (!link) continue;
      if (hasImageExtension(link)) {
        this.queueImage(link); // <a href="photo.jpg">: an image, any host
      } else if (depth < this.maxDepth && sameSite(link, this.root) && !this.visitedPages.has(link)) {
        next.push(link);
      }
    }
  }

  private queueImage(url: string): void {
    if (this.seenImages.has(url)) return;
    this.seenImages.add(url);
    this.downloads.push(this.imageLimiter.run(() => this.download(url)));
  }

  private async download(url: string): Promise<void> {
    let data: Buffer;
    try {
      data = await readBody(await request(url), MAX_IMAGE_SIZE);
    } catch (e) {
      console.error(`[!] image  ${url}: ${errorMessage(e)}`);
      return;
    }
    if (detectFormat(data) === null) {
      console.error(`[!] image  ${url}: not a valid jpg/png/gif/bmp`);
      return;
    }
    const path = this.claimPath(url, data);
    if (path === null) return;
    try {
      await writeFile(path, data);
    } catch (e) {
      console.error(`[!] write  ${path}: ${errorMessage(e)}`);
      return;
    }
    this.downloaded++;
    console.log(`[+] ${url} -> ${path}`);
  }

  /**
   * Pick a file name from the URL, avoiding collisions. Runs synchronously,
   * so two concurrent downloads can never claim the same path.
   */
  private claimPath(url: string, data: Buffer): string | null {
    let name = basename(decodeURIComponentSafe(new URL(url).pathname)) || "image";
    name = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    let path = join(this.dest, name);

    if (this.claimedPaths.has(path) || existsSync(path)) {
      // Same name already on disk with identical content -> skip.
      if (!this.claimedPaths.has(path) && readFileSync(path).equals(data)) return null;
      const dot = name.lastIndexOf(".");
      const digest = createHash("sha1").update(url).digest("hex").slice(0, 8);
      path = join(this.dest, `${name.slice(0, dot)}_${digest}${name.slice(dot)}`);
      if (this.claimedPaths.has(path)) return null;
    }
    this.claimedPaths.add(path);
    return path;
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------------- //
// Command line
// ------------------------------------------------------------------------- //
interface Options {
  recursive: boolean;
  depth: number | null;
  path: string;
  url: string;
}

const USAGE = "usage: spider [-h] [-r] [-l [N]] [-p PATH] URL";

function fail(message: string): never {
  console.error(`${USAGE}\nspider: error: ${message}`);
  process.exit(2);
}

/** Parse flags, accepting grouped short options like "-rl 3" or "-rl3". */
function parseArgs(argv: string[]): Options {
  const opts: Options = { recursive: false, depth: null, path: DEFAULT_PATH, url: "" };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (flag === "h") {
        console.log(`${USAGE}\n
Extract all images from a website.

options:
  -r        recursively download images from linked pages
  -l [N]    max recursion depth (with -r, default ${DEFAULT_DEPTH})
  -p PATH   output directory (default ${DEFAULT_PATH})`);
        process.exit(0);
      } else if (flag === "r") {
        opts.recursive = true;
      } else if (flag === "l" || flag === "p") {
        // value is the rest of this arg ("-l3") or the next arg ("-l 3")
        let value = arg.slice(j + 1);
        if (flag === "l" && /^-\d+$/.test(value || argv[i + 1] || "")) {
          fail("argument -l: N must be a positive number");
        }
        const nextArg = argv[i + 1] ?? "";
        if (!value && flag === "l" && !/^\d+$/.test(nextArg)) {
          // "-l abc": not a number and does not look like a URL either
          if (nextArg && !nextArg.startsWith("-") && !/[.:/]/.test(nextArg)) {
            fail(`argument -l: invalid number: '${nextArg}'`);
          }
          // "-r -l URL": N is optional ("-l [N]"), keep the default depth
          opts.depth = DEFAULT_DEPTH;
          break;
        }
        if (!value) {
          if (i + 1 >= argv.length) fail(`argument -${flag}: expected one argument`);
          value = argv[++i];
        }
        if (flag === "l") {
          if (!/^\d+$/.test(value)) fail(`argument -l: invalid number: '${value}'`);
          opts.depth = Number(value);
        } else {
          opts.path = value;
        }
        break;
      } else {
        fail(`unrecognized option: -${flag}`);
      }
    }
  }

  if (positional.length === 0) fail("the following arguments are required: URL");
  if (positional.length > 1) fail(`unrecognized arguments: ${positional.slice(1).join(" ")}`);
  if (opts.depth !== null && !opts.recursive) fail("-l requires -r");

  let url = positional[0];
  if (!url.includes("://")) url = "http://" + url;
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) throw new Error();
    opts.url = u.href;
  } catch {
    fail(`invalid URL: ${positional[0]}`);
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const depth = opts.recursive ? (opts.depth ?? DEFAULT_DEPTH) : 0;
  try {
    mkdirSync(opts.path, { recursive: true });
  } catch (e) {
    console.error(`spider: cannot create ${opts.path}: ${errorMessage(e)}`);
    return 1;
  }

  process.on("SIGINT", () => {
    console.error("\nspider: interrupted");
    process.exit(130);
  });

  const started = Date.now();
  const spider = new Spider(opts.url, depth, opts.path);
  const pages = await spider.crawl();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone: ${spider.downloaded} image(s) saved to ${opts.path} (${pages} URL(s) visited in ${seconds}s)`,
  );
  return 0;
}

// Flush stdout before exiting: when output is piped (| less), writes are
// asynchronous and process.exit() alone could cut the end of the report.
main().then((code) => process.stdout.write("", () => process.exit(code)));
