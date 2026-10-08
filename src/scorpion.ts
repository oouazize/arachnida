/**
 * scorpion - display EXIF and other metadata of image files.
 *
 * Usage: ./scorpion FILE1 [FILE2 ...]
 *
 * No imaging library is used: every format is parsed by hand from raw bytes
 * with Buffer.readUInt16BE() & co, following the official specifications:
 *   - JPEG : marker segments (ITU T.81), EXIF in APP1 (CIPA DC-008)
 *   - TIFF : IFD structure used inside EXIF (TIFF 6.0)
 *   - PNG  : chunks (W3C PNG spec)
 *   - GIF  : blocks and extensions (GIF89a spec)
 *   - BMP  : BITMAPFILEHEADER + BITMAPINFOHEADER
 */

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { inflateSync } from "node:zlib";

// ------------------------------------------------------------------------- //
// Types
// ------------------------------------------------------------------------- //
/** A TIFF RATIONAL: a fraction stored as two integers. */
interface Rational {
  num: number;
  den: number;
}
type Value = string | number | boolean | Rational | Buffer | (number | Rational)[];
type Section = Record<string, Value>;
type Sections = Record<string, Section>;

const isRational = (v: unknown): v is Rational =>
  typeof v === "object" && v !== null && "den" in v && "num" in v;

// ------------------------------------------------------------------------- //
// EXIF tag names (subset of the most useful ones)
// ------------------------------------------------------------------------- //
const TIFF_TAGS: Record<number, string> = {
  0x0100: "ImageWidth", 0x0101: "ImageLength", 0x0102: "BitsPerSample",
  0x0103: "Compression", 0x0106: "PhotometricInterpretation",
  0x010e: "ImageDescription", 0x010f: "Make", 0x0110: "Model",
  0x0112: "Orientation", 0x0115: "SamplesPerPixel",
  0x011a: "XResolution", 0x011b: "YResolution", 0x0128: "ResolutionUnit",
  0x0131: "Software", 0x0132: "DateTime", 0x013b: "Artist",
  0x013e: "WhitePoint", 0x013f: "PrimaryChromaticities",
  0x0201: "JPEGInterchangeFormat", 0x0202: "JPEGInterchangeFormatLength",
  0x0211: "YCbCrCoefficients", 0x0213: "YCbCrPositioning",
  0x0214: "ReferenceBlackWhite", 0x8298: "Copyright",
  0x8769: "ExifIFDPointer", 0x8825: "GPSInfoIFDPointer",
  0xa005: "InteroperabilityIFDPointer", 0x4746: "Rating",
  0x9c9b: "XPTitle", 0x9c9c: "XPComment", 0x9c9d: "XPAuthor",
  0x9c9e: "XPKeywords", 0x9c9f: "XPSubject",
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: "ExposureTime", 0x829d: "FNumber", 0x8822: "ExposureProgram",
  0x8827: "ISOSpeedRatings", 0x8830: "SensitivityType",
  0x9000: "ExifVersion", 0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized", 0x9010: "OffsetTime",
  0x9011: "OffsetTimeOriginal", 0x9012: "OffsetTimeDigitized",
  0x9101: "ComponentsConfiguration", 0x9102: "CompressedBitsPerPixel",
  0x9201: "ShutterSpeedValue", 0x9202: "ApertureValue",
  0x9203: "BrightnessValue", 0x9204: "ExposureBiasValue",
  0x9205: "MaxApertureValue", 0x9206: "SubjectDistance",
  0x9207: "MeteringMode", 0x9208: "LightSource", 0x9209: "Flash",
  0x920a: "FocalLength", 0x9214: "SubjectArea", 0x927c: "MakerNote",
  0x9286: "UserComment", 0x9290: "SubSecTime",
  0x9291: "SubSecTimeOriginal", 0x9292: "SubSecTimeDigitized",
  0xa000: "FlashpixVersion", 0xa001: "ColorSpace",
  0xa002: "PixelXDimension", 0xa003: "PixelYDimension",
  0xa005: "InteroperabilityIFDPointer", 0xa20e: "FocalPlaneXResolution",
  0xa20f: "FocalPlaneYResolution", 0xa210: "FocalPlaneResolutionUnit",
  0xa217: "SensingMethod", 0xa300: "FileSource", 0xa301: "SceneType",
  0xa401: "CustomRendered", 0xa402: "ExposureMode", 0xa403: "WhiteBalance",
  0xa404: "DigitalZoomRatio", 0xa405: "FocalLengthIn35mmFilm",
  0xa406: "SceneCaptureType", 0xa407: "GainControl", 0xa408: "Contrast",
  0xa409: "Saturation", 0xa40a: "Sharpness",
  0xa40c: "SubjectDistanceRange", 0xa420: "ImageUniqueID",
  0xa430: "CameraOwnerName", 0xa431: "BodySerialNumber",
  0xa432: "LensSpecification", 0xa433: "LensMake", 0xa434: "LensModel",
  0xa435: "LensSerialNumber",
};

const GPS_TAGS: Record<number, string> = {
  0x0000: "GPSVersionID", 0x0001: "GPSLatitudeRef", 0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef", 0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef", 0x0006: "GPSAltitude", 0x0007: "GPSTimeStamp",
  0x0008: "GPSSatellites", 0x0009: "GPSStatus", 0x000a: "GPSMeasureMode",
  0x000b: "GPSDOP", 0x000c: "GPSSpeedRef", 0x000d: "GPSSpeed",
  0x000e: "GPSTrackRef", 0x000f: "GPSTrack", 0x0010: "GPSImgDirectionRef",
  0x0011: "GPSImgDirection", 0x0012: "GPSMapDatum",
  0x0017: "GPSDestBearingRef", 0x0018: "GPSDestBearing",
  0x001b: "GPSProcessingMethod", 0x001d: "GPSDateStamp",
  0x001f: "GPSHPositioningError",
};

const INTEROP_TAGS: Record<number, string> = {
  0x0001: "InteroperabilityIndex",
  0x0002: "InteroperabilityVersion",
};

// Human readable values for a few enumerated tags.
const ENUMS: Record<string, Record<number, string>> = {
  Orientation: {
    1: "Horizontal (normal)", 2: "Mirror horizontal", 3: "Rotate 180",
    4: "Mirror vertical", 5: "Mirror horizontal and rotate 270 CW",
    6: "Rotate 90 CW", 7: "Mirror horizontal and rotate 90 CW", 8: "Rotate 270 CW",
  },
  ResolutionUnit: { 1: "None", 2: "inches", 3: "cm" },
  ExposureProgram: {
    0: "Not defined", 1: "Manual", 2: "Normal program", 3: "Aperture priority",
    4: "Shutter priority", 5: "Creative", 6: "Action", 7: "Portrait", 8: "Landscape",
  },
  MeteringMode: {
    0: "Unknown", 1: "Average", 2: "Center-weighted", 3: "Spot",
    4: "Multi-spot", 5: "Pattern", 6: "Partial",
  },
  ColorSpace: { 1: "sRGB", 0xffff: "Uncalibrated" },
  WhiteBalance: { 0: "Auto", 1: "Manual" },
  ExposureMode: { 0: "Auto", 1: "Manual", 2: "Auto bracket" },
  YCbCrPositioning: { 1: "Centered", 2: "Co-sited" },
  SceneCaptureType: { 0: "Standard", 1: "Landscape", 2: "Portrait", 3: "Night" },
  Compression: { 1: "Uncompressed", 6: "JPEG (old-style)", 7: "JPEG" },
};

// TIFF field types: id -> size in bytes of one element
const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL  (two LONGs: numerator / denominator)
  6: 1, // SBYTE
  7: 1, // UNDEFINED (raw bytes)
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

// ------------------------------------------------------------------------- //
// Small byte helpers
// ------------------------------------------------------------------------- //
const startsWith = (buf: Buffer, prefix: string | number[]): boolean => {
  const p = typeof prefix === "string" ? Buffer.from(prefix, "latin1") : Buffer.from(prefix);
  return buf.length >= p.length && buf.subarray(0, p.length).equals(p);
};

/** Split at the first NUL byte: [before, after]. Like Python's partition. */
const splitNul = (buf: Buffer): [Buffer, Buffer] => {
  const i = buf.indexOf(0);
  return i < 0 ? [buf, Buffer.alloc(0)] : [buf.subarray(0, i), buf.subarray(i + 1)];
};

/** Shortest readable form of a number, like Python's "%g". */
const g = (x: number): string => String(Number(x.toPrecision(6)));

const ratio = (r: Rational): number => (r.den ? r.num / r.den : 0);

// ------------------------------------------------------------------------- //
// TIFF / EXIF parser
// ------------------------------------------------------------------------- //
/**
 * Parse a TIFF structure (the container used by EXIF).
 *
 * Layout:
 *   [0:2]  byte order: "II" (little endian, Intel) or "MM" (big, Motorola)
 *   [2:4]  magic 42
 *   [4:8]  offset of the first IFD (Image File Directory)
 * Each IFD:
 *   2 bytes   number of entries
 *   12 bytes per entry: tag(2) type(2) count(4) value-or-offset(4)
 *   4 bytes   offset of the next IFD (0 = none)
 * All offsets are relative to the start of the TIFF header.
 */
class TiffParser {
  private readonly data: Buffer;
  private readonly le: boolean;
  private readonly visited = new Set<number>(); // protects against IFD loops

  constructor(data: Buffer) {
    this.data = data;
    const order = data.subarray(0, 2).toString("latin1");
    if (order === "II") this.le = true;
    else if (order === "MM") this.le = false;
    else throw new Error("bad TIFF byte order");
    if (this.u16(2) !== 42) throw new Error("bad TIFF magic");
  }

  private u16(o: number): number {
    return this.le ? this.data.readUInt16LE(o) : this.data.readUInt16BE(o);
  }

  private u32(o: number): number {
    return this.le ? this.data.readUInt32LE(o) : this.data.readUInt32BE(o);
  }

  private i16(o: number): number {
    return this.le ? this.data.readInt16LE(o) : this.data.readInt16BE(o);
  }

  private i32(o: number): number {
    return this.le ? this.data.readInt32LE(o) : this.data.readInt32BE(o);
  }

  /** Return [name -> value, next IFD offset]. */
  readIfd(offset: number, names: Record<number, string>): [Section, number] {
    if (this.visited.has(offset) || offset + 2 > this.data.length) return [{}, 0];
    this.visited.add(offset);
    const result: Section = {};
    const count = this.u16(offset);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > this.data.length) break;
      const tag = this.u16(entry);
      const type = this.u16(entry + 2);
      const n = this.u32(entry + 4);
      const name = names[tag] ?? `Tag0x${tag.toString(16).toUpperCase().padStart(4, "0")}`;
      try {
        result[name] = this.readValue(type, n, entry + 8);
      } catch {
        continue; // unknown type or value out of bounds: skip this tag
      }
    }
    const nextPos = offset + 2 + count * 12;
    const next = nextPos + 4 <= this.data.length ? this.u32(nextPos) : 0;
    return [result, next];
  }

  private readValue(type: number, count: number, fieldPos: number): Value {
    const size = TIFF_TYPE_SIZE[type];
    if (size === undefined) throw new Error("unknown type");
    const total = size * count;
    // Values of 4 bytes or less are stored inline in the entry itself;
    // larger values are stored elsewhere and the field holds an offset.
    const pos = total <= 4 ? fieldPos : this.u32(fieldPos);
    if (pos + total > this.data.length) throw new Error("value out of bounds");
    const raw = this.data.subarray(pos, pos + total);

    if (type === 2) return splitNul(raw)[0].toString("utf8").trim(); // ASCII
    if (type === 7) return Buffer.from(raw); // UNDEFINED

    const values: (number | Rational)[] = [];
    for (let i = 0; i < count; i++) {
      const o = pos + i * size;
      switch (type) {
        case 1: values.push(this.data.readUInt8(o)); break;
        case 6: values.push(this.data.readInt8(o)); break;
        case 3: values.push(this.u16(o)); break;
        case 8: values.push(this.i16(o)); break;
        case 4: values.push(this.u32(o)); break;
        case 9: values.push(this.i32(o)); break;
        case 5: values.push({ num: this.u32(o), den: this.u32(o + 4) }); break;
        case 10: values.push({ num: this.i32(o), den: this.i32(o + 4) }); break;
        case 11: values.push(this.le ? this.data.readFloatLE(o) : this.data.readFloatBE(o)); break;
        case 12: values.push(this.le ? this.data.readDoubleLE(o) : this.data.readDoubleBE(o)); break;
      }
    }
    return count === 1 ? values[0] : values;
  }

  /** Walk IFD0, its sub-IFDs (Exif, GPS, Interop) and IFD1 (thumbnail). */
  parse(): Sections {
    const sections: Sections = {};
    const [ifd0, ifd1Offset] = this.readIfd(this.u32(4), TIFF_TAGS);
    sections["Image (IFD0)"] = ifd0;

    const exifOffset = ifd0.ExifIFDPointer;
    const gpsOffset = ifd0.GPSInfoIFDPointer;
    delete ifd0.ExifIFDPointer;
    delete ifd0.GPSInfoIFDPointer;

    if (typeof exifOffset === "number") {
      const [exif] = this.readIfd(exifOffset, EXIF_TAGS);
      const interopOffset = exif.InteroperabilityIFDPointer;
      delete exif.InteroperabilityIFDPointer;
      sections.Exif = exif;
      if (typeof interopOffset === "number") {
        sections.Interoperability = this.readIfd(interopOffset, INTEROP_TAGS)[0];
      }
    }
    if (typeof gpsOffset === "number") {
      const [gps] = this.readIfd(gpsOffset, GPS_TAGS);
      sections.GPS = gps;
      const coords = gpsToDecimal(gps);
      if (coords) gps["Position (decimal)"] = coords;
    }
    if (ifd1Offset) sections["Thumbnail (IFD1)"] = this.readIfd(ifd1Offset, TIFF_TAGS)[0];

    for (const key of Object.keys(sections)) {
      if (Object.keys(sections[key]).length === 0) delete sections[key];
    }
    return sections;
  }
}

/** ((deg),(min),(sec)) + N/S/E/W ref -> '48.858370, 2.294481' */
function gpsToDecimal(gps: Section): string | null {
  const conv = (dms: Value | undefined, ref: Value | undefined): number | null => {
    if (!Array.isArray(dms) || dms.length !== 3 || !dms.every(isRational)) return null;
    const [d, m, s] = (dms as Rational[]).map(ratio);
    const val = d + m / 60 + s / 3600;
    return ref === "S" || ref === "W" ? -val : val;
  };
  const lat = conv(gps.GPSLatitude, gps.GPSLatitudeRef);
  const lon = conv(gps.GPSLongitude, gps.GPSLongitudeRef);
  return lat === null || lon === null ? null : `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

// ------------------------------------------------------------------------- //
// Value formatting
// ------------------------------------------------------------------------- //
function fmtValue(name: string, value: Value): string {
  if (name in ENUMS && typeof value === "number") return ENUMS[name][value] ?? String(value);
  if (name.startsWith("XP") && Array.isArray(value)) {
    // Windows XP tags: UTF-16LE text stored as a BYTE array
    return Buffer.from(value as number[]).toString("utf16le").replace(/\0+$/, "");
  }
  if (isRational(value)) {
    if (name === "ExposureTime") {
      return value.num && value.den > value.num
        ? `1/${Math.round(value.den / value.num)} s`
        : `${g(ratio(value))} s`;
    }
    if (name === "FNumber") return `f/${ratio(value).toFixed(1)}`;
    if (name === "FocalLength") return `${ratio(value).toFixed(1)} mm`;
    return g(ratio(value));
  }
  if (Buffer.isBuffer(value)) {
    if (name.endsWith("Version")) return value.toString("latin1");
    if (name === "UserComment") {
      // 8-byte character-code prefix, then the comment
      return value.subarray(8).toString("utf8").replace(/^[\0 ]+|[\0 ]+$/g, "") || "(empty)";
    }
    if (value.length > 32) return `<${value.length} bytes of binary data>`;
    return [...value].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  }
  if (Array.isArray(value)) {
    if (value.length > 16) return `<${value.length} values>`;
    return value.map((v) => (isRational(v) ? g(ratio(v)) : String(v))).join(", ");
  }
  return String(value);
}

// ------------------------------------------------------------------------- //
// Format-specific parsers. Each returns { section name: { key: value } }
// ------------------------------------------------------------------------- //
const SOF_MARKERS: Record<number, string> = {
  0xc0: "Baseline DCT",
  0xc1: "Extended sequential DCT",
  0xc2: "Progressive DCT",
  0xc3: "Lossless",
};

interface Segment {
  marker: number;
  payload: Buffer;
}

/**
 * Yield each segment before the image data. A JPEG is a sequence of
 * segments: 0xFF <marker> <len:2> <payload>. The length includes its own
 * 2 bytes. SOS (0xDA) starts the compressed image data, after which we stop.
 */
function* iterJpegSegments(data: Buffer): Generator<Segment> {
  let pos = 2; // skip SOI (FF D8)
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) throw new Error(`bad JPEG marker at offset ${pos}`);
    const marker = data[pos + 1];
    if (marker === 0xff) { pos += 1; continue; } // padding byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // markers without length
      continue;
    }
    if (marker === 0xd9) return; // EOI
    const length = data.readUInt16BE(pos + 2);
    const end = pos + 2 + length;
    if (end > data.length) throw new Error("file is truncated");
    yield { marker, payload: data.subarray(pos + 4, end) };
    if (marker === 0xda) return; // SOS: compressed data follows
    pos = end;
  }
}

function parseExif(tiff: Buffer, sections: Sections): void {
  try {
    Object.assign(sections, new TiffParser(tiff).parse());
  } catch (e) {
    sections.Exif = { Error: `corrupt EXIF (${(e as Error).message})` };
  }
}

function parseJpeg(data: Buffer): Sections {
  const info: Section = {};
  const sections: Sections = {};
  const comments: string[] = [];

  for (const { marker, payload } of iterJpegSegments(data)) {
    if (marker in SOF_MARKERS && payload.length >= 6) {
      info.Width = payload.readUInt16BE(3);
      info.Height = payload.readUInt16BE(1);
      info["Bits per sample"] = payload[0];
      info["Color components"] = payload[5];
      info.Encoding = SOF_MARKERS[marker];
    } else if (marker === 0xe0 && startsWith(payload, "JFIF\0") && payload.length >= 12) {
      const units = ["aspect ratio", "dpi", "dpcm"][payload[7]] ?? "?";
      info["JFIF version"] = `${payload[5]}.${String(payload[6]).padStart(2, "0")}`;
      info.Density = `${payload.readUInt16BE(8)}x${payload.readUInt16BE(10)} ${units}`;
    } else if (marker === 0xe1 && startsWith(payload, "Exif\0\0")) {
      parseExif(payload.subarray(6), sections);
    } else if (marker === 0xe1 && startsWith(payload, "http://ns.adobe.com/xap")) {
      const xmp = splitNul(payload)[1];
      sections.XMP = { Size: `${xmp.length} bytes`, ...parseXmp(xmp) };
    } else if (marker === 0xe2 && startsWith(payload, "ICC_PROFILE\0")) {
      info["ICC profile"] = "present";
    } else if (marker === 0xed && startsWith(payload, "Photoshop 3.0")) {
      info["IPTC/Photoshop data"] = `${payload.length} bytes`;
    } else if (marker === 0xfe) {
      comments.push(payload.toString("utf8"));
    }
  }
  if (comments.length) info.Comment = comments.join(" | ");
  return { JPEG: info, ...sections };
}

/** Pick a few well-known fields out of the XMP (XML) packet. */
function parseXmp(xmp: Buffer): Section {
  const text = xmp.toString("utf8");
  const found: Section = {};
  const keys = [
    "xmp:CreatorTool", "xmp:CreateDate", "xmp:ModifyDate",
    "photoshop:DateCreated", "exif:DateTimeOriginal",
    "tiff:Make", "tiff:Model", "dc:creator", "dc:title",
  ];
  for (const key of keys) {
    // attribute form key="value"  or  element form <key>value<
    const m = new RegExp(`${key}="([^"]*)"|<${key}>([^<]*)<`).exec(text);
    const value = (m?.[1] ?? m?.[2] ?? "").trim();
    if (value) found[key] = value.slice(0, 100);
  }
  return found;
}

const PNG_COLOR_TYPES: Record<number, string> = {
  0: "Grayscale", 2: "RGB", 3: "Indexed", 4: "Grayscale + alpha", 6: "RGBA",
};

interface Chunk {
  type: string;
  payload: Buffer;
}

/** Each chunk: length(4) type(4) data(length) crc(4) */
function* iterPngChunks(data: Buffer): Generator<Chunk> {
  let pos = 8; // skip the 8-byte PNG signature
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString("latin1");
    const end = pos + 12 + length;
    yield { type, payload: data.subarray(pos + 8, pos + 8 + length) };
    if (type === "IEND") return;
    pos = end;
  }
}

function parsePng(data: Buffer): Sections {
  const info: Section = {};
  const text: Section = {};
  const sections: Sections = {};
  let frames = 0;

  for (const { type, payload: p } of iterPngChunks(data)) {
    if (type === "IHDR") {
      info.Width = p.readUInt32BE(0);
      info.Height = p.readUInt32BE(4);
      info["Bit depth"] = p[8];
      info["Color type"] = PNG_COLOR_TYPES[p[9]] ?? p[9];
      info.Interlace = p[12] ? "Adam7" : "None";
    } else if (type === "tEXt") {
      const [key, val] = splitNul(p);
      text[key.toString("latin1")] = val.toString("latin1");
    } else if (type === "zTXt") {
      const [key, rest] = splitNul(p);
      let val: string;
      try {
        val = inflateSync(rest.subarray(1)).toString("latin1");
      } catch {
        val = "<corrupt compressed text>";
      }
      text[key.toString("latin1")] = val;
    } else if (type === "iTXt") {
      // key \0 compressed(1) method(1) language \0 translated-key \0 text
      const [key, rest] = splitNul(p);
      const compressed = rest[0] ?? 0;
      const [, afterLang] = splitNul(rest.subarray(2));
      let [, val] = splitNul(afterLang);
      if (compressed) {
        try {
          val = inflateSync(val);
        } catch {
          val = Buffer.from("<corrupt compressed text>");
        }
      }
      text[key.toString("latin1")] = val.toString("utf8").slice(0, 500);
    } else if (type === "tIME" && p.length === 7) {
      const pad = (n: number) => String(n).padStart(2, "0");
      info["Last modified (tIME)"] =
        `${p.readUInt16BE(0)}-${pad(p[2])}-${pad(p[3])} ${pad(p[4])}:${pad(p[5])}:${pad(p[6])} UTC`;
    } else if (type === "pHYs" && p.length === 9) {
      const x = p.readUInt32BE(0);
      const y = p.readUInt32BE(4);
      if (p[8] === 1) info.Resolution = `${Math.round(x * 0.0254)}x${Math.round(y * 0.0254)} dpi`;
      else info["Pixel aspect"] = `${x}:${y}`;
    } else if (type === "gAMA" && p.length === 4) {
      info.Gamma = p.readUInt32BE(0) / 100000;
    } else if (type === "sRGB") {
      info.sRGB = "yes";
    } else if (type === "iCCP") {
      info["ICC profile"] = splitNul(p)[0].toString("latin1");
    } else if (type === "acTL") {
      info["Animated (APNG)"] = "yes";
    } else if (type === "fcTL") {
      frames++;
    } else if (type === "eXIf") {
      parseExif(p, sections);
    }
  }
  if (frames) info.Frames = frames;
  const out: Sections = { PNG: info };
  if (Object.keys(text).length) out["Text chunks"] = text;
  return { ...out, ...sections };
}

/**
 * Header(6) + Logical Screen Descriptor(7) [+ Global Color Table], then
 * blocks: 0x2C image, 0x21 extension, 0x3B trailer.
 */
function parseGif(data: Buffer): Sections {
  const flags = data[10];
  const info: Section = {
    Version: data.subarray(0, 6).toString("latin1"),
    Width: data.readUInt16LE(6),
    Height: data.readUInt16LE(8),
    "Global color table": Boolean(flags & 0x80),
    "Color resolution": `${((flags >> 4) & 7) + 1} bits`,
  };
  let pos = 13;
  if (flags & 0x80) pos += 3 * (2 << (flags & 7));

  // Data is stored as sub-blocks: size(1) bytes(size) ... until size 0
  const readSubBlocks = (start: number): [number, Buffer] => {
    const parts: Buffer[] = [];
    let p = start;
    while (p < data.length && data[p] !== 0) {
      parts.push(data.subarray(p + 1, p + 1 + data[p]));
      p += data[p] + 1;
    }
    return [p + 1, Buffer.concat(parts)];
  };

  let frames = 0;
  const comments: string[] = [];
  const apps: string[] = [];
  while (pos < data.length) {
    const block = data[pos];
    if (block === 0x3b) break; // trailer
    if (block === 0x2c) {
      // image descriptor
      frames++;
      const iflags = data[pos + 9];
      pos += 10;
      if (iflags & 0x80) pos += 3 * (2 << (iflags & 7)); // local color table
      pos += 1; // LZW min code size
      [pos] = readSubBlocks(pos);
    } else if (block === 0x21) {
      // extension
      const label = data[pos + 1];
      let body: Buffer;
      [pos, body] = readSubBlocks(pos + 2);
      if (label === 0xfe) {
        comments.push(body.toString("latin1"));
      } else if (label === 0xff && body.length >= 11) {
        const app = body.subarray(0, 11).toString("latin1");
        apps.push(app);
        if (app === "NETSCAPE2.0" && body.length >= 14) {
          const loops = body.readUInt16LE(12);
          info["Loop count"] = loops === 0 ? "infinite" : loops;
        }
      }
    } else {
      break; // corrupt / unknown
    }
  }
  info.Frames = frames;
  info.Animated = frames > 1;
  if (comments.length) info.Comment = comments.join(" | ");
  if (apps.length) info["Application extensions"] = apps.join(", ");
  return { GIF: info };
}

const BMP_COMPRESSION: Record<number, string> = {
  0: "None (BI_RGB)", 1: "RLE8", 2: "RLE4", 3: "Bitfields", 4: "JPEG", 5: "PNG",
};

function parseBmp(data: Buffer): Sections {
  const headerSize = data.readUInt32LE(14);
  const info: Section = {
    "Declared file size": data.readUInt32LE(2),
    "DIB header size": headerSize,
  };
  if (headerSize === 12) {
    // old OS/2 BITMAPCOREHEADER
    info.Width = data.readUInt16LE(18);
    info.Height = data.readUInt16LE(20);
    info["Bits per pixel"] = data.readUInt16LE(24);
    return { BMP: info };
  }
  const h = data.readInt32LE(22);
  const bpp = data.readUInt16LE(28);
  const comp = data.readUInt32LE(30);
  const colors = data.readUInt32LE(46);
  info.Width = data.readInt32LE(18);
  info.Height = Math.abs(h);
  info["Row order"] = h < 0 ? "top-down" : "bottom-up";
  info["Bits per pixel"] = bpp;
  info.Compression = BMP_COMPRESSION[comp] ?? comp;
  info.Resolution = `${Math.round(data.readInt32LE(38) * 0.0254)}x${Math.round(data.readInt32LE(42) * 0.0254)} dpi`;
  info["Palette colors"] = colors || (bpp <= 8 ? 2 ** bpp : 0);
  return { BMP: info };
}

type Format = "JPEG" | "PNG" | "GIF" | "BMP";

const PARSERS: [number[] | string, Format, (d: Buffer) => Sections][] = [
  [[0xff, 0xd8, 0xff], "JPEG", parseJpeg],
  ["\x89PNG\r\n\x1a\n", "PNG", parsePng],
  ["GIF87a", "GIF", parseGif],
  ["GIF89a", "GIF", parseGif],
  ["BM", "BMP", parseBmp],
];

/** Identify the format by its magic bytes, never by its extension. */
function detect(data: Buffer): [Format, (d: Buffer) => Sections] | null {
  for (const [magic, name, parser] of PARSERS) {
    if (startsWith(data, magic)) return [name, parser];
  }
  return null;
}

// ------------------------------------------------------------------------- //
// Basic attributes (from the file system)
// ------------------------------------------------------------------------- //
/** Local time with its UTC offset, e.g. "2026-10-08 17:46:05 (UTC+01:00)" */
function ts(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off < 0 ? "-" : "+";
  const zone = `UTC${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${zone})`;
}

async function fileAttributes(path: string, format: Format): Promise<Section> {
  const st = await stat(path);
  const attrs: Section = {
    "File name": basename(path),
    Path: resolve(path),
    Format: format,
    Size: `${st.size} bytes`,
  };
  // birthtime is the real creation date on macOS. On Linux it may be
  // unavailable (0), and ctime is the last metadata change, not creation.
  if (st.birthtimeMs > 0) attrs.Created = ts(st.birthtime);
  else attrs["Changed (ctime)"] = ts(st.ctime);
  attrs.Modified = ts(st.mtime);
  attrs.Accessed = ts(st.atime);
  attrs.Permissions = "0o" + (st.mode & 0o777).toString(8);
  return attrs;
}

// ------------------------------------------------------------------------- //
// Display
// ------------------------------------------------------------------------- //
function sectionText(title: string, entries: Section): string {
  const keys = Object.keys(entries);
  const width = Math.max(0, ...keys.map((k) => k.length));
  const lines = keys.map((k) => `    ${k.padEnd(width)} : ${fmtValue(k, entries[k])}`);
  return `  [${title}]\n${lines.join("\n")}\n`;
}

const FS_ERRORS: Record<string, string> = {
  ENOENT: "No such file or directory",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENAMETOOLONG: "File name too long",
};

/** "ENOENT: no such file..., open 'x'" -> "No such file or directory" */
function fsError(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return FS_ERRORS[err.code ?? ""] ?? err.message.replace(/^\w+: /, "").split(",")[0];
}

/** Build the whole report for one file as a string (printed by main). */
async function analyze(path: string): Promise<[boolean, string]> {
  const bar = "=".repeat(70);
  let out = `${bar}\n  ${path}\n${bar}\n`;

  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (e) {
    return [false, out + `  Error: ${fsError(e)}\n`];
  }

  const found = detect(data);
  if (!found) return [false, out + "  Error: unsupported format (expected jpg, png, gif or bmp)\n"];
  const [format, parser] = found;

  out += sectionText("File", await fileAttributes(path, format));
  let sections: Sections;
  try {
    sections = parser(data);
  } catch (e) {
    return [false, out + `  Error: corrupt ${format} file (${(e as Error).message})\n`];
  }

  let hasExif = false;
  for (const [title, entries] of Object.entries(sections)) {
    if (Object.keys(entries).length === 0) continue;
    out += sectionText(title, entries);
    if (title === "Image (IFD0)" || title === "Exif" || title === "GPS") hasExif = true;
  }
  if (!hasExif) out += "  [Exif]\n    (no EXIF data)\n";
  return [true, out];
}

// ------------------------------------------------------------------------- //
// Command line
// ------------------------------------------------------------------------- //
const USAGE = "usage: scorpion [-h] FILE [FILE ...]";

async function main(): Promise<number> {
  const files: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      files.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(`${USAGE}\n\nDisplay EXIF and other metadata of image files.`);
      return 0;
    }
    if (arg.startsWith("-") && arg !== "-") {
      console.error(`${USAGE}\nscorpion: error: unrecognized option: ${arg}`);
      return 2;
    }
    files.push(arg);
  }
  if (files.length === 0) {
    console.error(`${USAGE}\nscorpion: error: the following arguments are required: FILE`);
    return 2;
  }

  // Read and parse all files in parallel, then print in the given order.
  const reports = await Promise.all(files.map(analyze));
  for (const [, text] of reports) console.log(text);
  return reports.every(([ok]) => ok) ? 0 : 1;
}

// Flush stdout before exiting: when output is piped (| less), writes are
// asynchronous and process.exit() alone could cut the end of the report.
main().then((code) => process.stdout.write("", () => process.exit(code)));
