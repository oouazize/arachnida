# Arachnida

42 Cybersecurity Piscine — introduction to web scraping and metadata.
TypeScript, Node.js ≥ 20, **zero runtime dependencies**.

| Program    | Role                                                         |
|------------|--------------------------------------------------------------|
| `spider`   | Recursively download `.jpg/.jpeg/.png/.gif/.bmp` from a site |
| `scorpion` | Parse and display file attributes, EXIF and other metadata   |

## Build

```sh
make        # npm install (typescript only) + compile src/*.ts -> dist/*.js
make re     # rebuild from scratch
make fclean # remove build output and node_modules
```

## Usage

```sh
./spider [-r] [-l [N]] [-p PATH] URL
#   -r        follow links recursively (same host only)
#   -l [N]    max depth with -r (default 5, N may be omitted)
#   -p PATH   output directory (default ./data/)
#   flags can be grouped: -rl 3, -rl3

./scorpion FILE1 [FILE2 ...]
```

## Rules respected

- No `wget`, `scrapy`, `cheerio`, `sharp`, `exif-parser`, `exiftool`.
- `fetch()` only sends HTTP requests; `node:fs` only reads/writes files.
- HTML tokenizer, crawler, URL resolution, image detection and **every binary
  format parser** (JPEG segments, TIFF/EXIF IFDs, PNG chunks, GIF blocks, BMP
  header) are written by hand.
- `typescript` is a dev dependency only (the compiler), never used at runtime.

## Files

```
src/spider.ts     crawler + downloader
src/scorpion.ts   metadata parser
Makefile          builds and creates ./spider and ./scorpion launchers
```

## Design notes

**spider**
- Breadth-first, level by level. Depth 0 = the given page. Without `-r` only
  that page is scanned.
- **Concurrent**: up to 8 pages and 16 images in flight at once (`Limiter`
  class). Example: books.toscrape.com with `-r -l 1` = 537 images in ~8 s.
- `visitedPages` / `seenImages` sets: nothing fetched twice, loops end.
- Only pages on the starting host are followed (after redirects, so
  `example.com` -> `www.example.com` works); images may come from any host
  (CDNs).
- HTML comments and `<script>/<style>` bodies are removed before tokenizing,
  so `"<img src=x>"` inside JavaScript is not mistaken for a real tag.
- Every download is checked by magic bytes: an HTML 404 page named `x.jpg`
  is rejected.
- Same file name, different content -> suffix with a hash of the URL.

**scorpion**
- Format detected by magic bytes, never by extension.
- JPEG: walks `FF xx` segments until SOS. APP1 `Exif\0\0` -> TIFF parser.
- TIFF/EXIF: byte order `II`/`MM`, IFD0 -> Exif IFD, GPS IFD, Interop, IFD1.
  GPS degrees/minutes/seconds converted to decimal coordinates.
- PNG: IHDR, tEXt/zTXt/iTXt, tIME, pHYs, eXIf (EXIF in PNG).
- GIF: version, size, frames, loop count, comment extensions.
- BMP: header fields (no EXIF exists in BMP).
- All files are read and parsed in parallel, printed in argument order.

Bonus part not implemented (mandatory part only).
