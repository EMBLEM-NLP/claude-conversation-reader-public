/**
 * @file speaker-image-extractor.ts
 * @description Download VOID Acoustics and Bias amplifier product PDFs, render cover
 *              photos and/or technical dimensional line drawings, remove white background,
 *              and save as transparent PNGs for use in venue tech pack SVG diagrams.
 * @version 2.2.0
 * @created 2026-04-26T22:15:41Z
 * @lastUpdated 2026-04-27T02:52:33Z
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

// ── Poppler (pdftoppm) helpers ────────────────────────────────────────────────

// Winget installs poppler outside PATH on Windows — remember the resolved binary across calls.
let resolvedPdftoppm: string | null = null;

async function findPdftoppm(): Promise<string> {
  if (resolvedPdftoppm) return resolvedPdftoppm;

  // 1. Explicit override via env var
  if (process.env.PDFTOPPM_PATH && fs.existsSync(process.env.PDFTOPPM_PATH)) {
    resolvedPdftoppm = process.env.PDFTOPPM_PATH;
    return resolvedPdftoppm;
  }

  // 2. In PATH
  try {
    await execFileAsync('pdftoppm', ['-v'], { timeout: 5000 });
    resolvedPdftoppm = 'pdftoppm';
    return resolvedPdftoppm;
  } catch {}

  // 3. Known winget install location on Windows (oschwartz10612.Poppler)
  const wingetBin =
    'C:/Users/romar/AppData/Local/Microsoft/WinGet/Packages/' +
    'oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/' +
    'poppler-25.07.0/Library/bin/pdftoppm.exe';
  if (fs.existsSync(wingetBin)) {
    resolvedPdftoppm = wingetBin;
    return resolvedPdftoppm;
  }

  throw new Error(
    'pdftoppm not found. Install poppler (winget install oschwartz10612.Poppler) ' +
      'or set PDFTOPPM_PATH env var.',
  );
}

/**
 * Render a single PDF page to PNG using pdftoppm (poppler).
 * Used as a fallback when pdfjs fails to render vector content (e.g. VOID PDFs).
 * dpi=144 matches the scale=2 output of renderPdfPage (72 DPI baseline × 2).
 */
async function renderPdfPageWithPoppler(pdfPath: string, pageNum: number, dpi = 144): Promise<Buffer> {
  const cmd = await findPdftoppm();
  const tmpPrefix = path.join(os.tmpdir(), `ccr_pdfrender_${Date.now()}`);

  await execFileAsync(cmd, [
    '-png',
    '-r', String(dpi),
    '-f', String(pageNum),
    '-l', String(pageNum),
    pdfPath,
    tmpPrefix,
  ]);

  // pdftoppm appends the page number (zero-padded to digit count of total pages)
  const tmpDir = path.dirname(tmpPrefix);
  const prefix = path.basename(tmpPrefix);
  const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(prefix) && f.endsWith('.png'));
  if (files.length === 0) throw new Error(`pdftoppm produced no output for page ${pageNum}`);

  const result = fs.readFileSync(path.join(tmpDir, files[0]));
  for (const f of files) {
    try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
  }
  return result;
}

// ── pdfjs-dist v3 legacy CJS build — compatible with Node 20.
// Empty workerSrc triggers the v3 in-process fake worker (no process.getBuiltinModule needed).
let pdfjsLib: typeof import('pdfjs-dist') | null = null;
async function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsLib) {
    pdfjsLib = (await import('pdfjs-dist/legacy/build/pdf.js')) as unknown as typeof import('pdfjs-dist');
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';
  }
  return pdfjsLib;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** Pixel bounding box at scale=2 (144 DPI rendered resolution). */
export interface ViewBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpeakerPdf {
  slug: string;        // output PNG basename (no .ext)
  label: string;       // human-readable name for progress output
  url: string;         // public CloudFront PDF URL
  pdfFilename: string; // basename when saving the original PDF
  /**
   * Technical dimensional line drawing location within the PDF.
   * Undefined = no usable drawing in this PDF (skip dims extraction silently).
   * page: 1-based PDF page number containing the orthographic views.
   * pageCrop: optional outer crop applied to the whole rendered page before white removal
   *           (use when two models share a page — e.g. Venu 215 + Venu 208 on p.45).
   * views: per-view crop bboxes within the (optionally pre-cropped) dims image.
   *        Populated after measuring the rendered dims PNG in an image viewer.
   */
  dimensions?: {
    page: number;
    pageCrop?: ViewBBox;
    views?: {
      front?: ViewBBox;
      side?: ViewBBox;
      top?: ViewBBox;
    };
  };
}

export type ExtractionMode = 'cover' | 'dims' | 'both';

export interface ExtractionResult {
  coverPath: string | null;
  dimsPath: string | null;
  viewPaths: Partial<Record<'front' | 'side' | 'top', string>>;
  pdfPath: string | null;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// All dims PNGs rendered at scale=2 (144 DPI). Bboxes are pixel coords at that resolution.
// pageCrop bboxes are absolute (applied to the full rendered page).
// views bboxes are relative to the pageCrop origin (or to the full page if no pageCrop).
// Bboxes derived 2026-04-27 by programmatic gap analysis of the rendered dims PNGs.

export const SPEAKER_PDFS: SpeakerPdf[] = [
  {
    slug: 'void-air-motion-v2',
    label: 'VOID Air Motion V2',
    url: 'https://d181c7pevbxova.cloudfront.net/media/support-materials/pdfs/Void%20Technical%20Public/User%20guides%20V2/UG10519-2.0%20-%20Air%20Motion%20User%20Guide.pdf',
    pdfFilename: 'VOID-Air-Motion-V2-User-Guide.pdf',
    dimensions: {
      page: 8,
      // Page 8: Fig 3.3 (RH) in top band y281-666, Fig 3.4 (LH) below. pageCrop isolates RH only.
      // Three horizontal zones detected by col gap analysis (gaps at x416-445 and x611-642).
      // View labels are best-guess from physical geometry — verify visually and swap if wrong.
      pageCrop: { x: 175, y: 278, w: 975, h: 395 },
      views: {
        front: { x: 0,   y: 3, w: 241, h: 385 },
        side:  { x: 271, y: 3, w: 165, h: 385 },
        top:   { x: 468, y: 3, w: 507, h: 385 },
      },
    },
  },
  {
    slug: 'void-stasys-xair',
    label: 'VOID Stasys Xair',
    url: 'https://d181c7pevbxova.cloudfront.net/media/UG10526%20-%202.1%20-%20Stasys%20Xair%20User%20Guide.pdf',
    pdfFilename: 'VOID-Stasys-Xair-User-Guide.pdf',
    dimensions: {
      page: 7,
      // Page 7: specs table fills upper ~60%, Fig 3.1 (all 3 views) in lower band y940-1270.
      // No column or row gaps detected within the drawing — the 3 views touch without whitespace.
      // pageCrop isolates just the drawing zone. Individual view bboxes need visual measurement.
      pageCrop: { x: 270, y: 940, w: 890, h: 330 },
      // views: TODO — open void-stasys-xair-dims.png after re-running --mode dims with this pageCrop
      //   and measure front/side/top bboxes in an image viewer that shows pixel coords (Photopea, etc.)
    },
  },
  {
    slug: 'void-venu-215-v2',
    label: 'VOID Venu 215 V2',
    url: 'https://d181c7pevbxova.cloudfront.net/media/support-materials/pdfs/Void%20Technical%20Public/User%20guides%20V2/UG10579-2.0%20-%20Venu%20V2%20Series%20User%20Guide.pdf',
    pdfFilename: 'VOID-Venu-V2-Series-User-Guide.pdf',
    dimensions: {
      page: 45,
      // Page 45 has Venu 215 V2 (Fig B.9, top) and Venu 208 V2 (Fig B.10, bottom).
      // pageCrop isolates Venu 215 only (y270-885); Venu 208 starts at y929.
      // Top row (y275-449): front left (x256-557), side right (x736-1150), gap x557-736.
      // Bottom row (y563-851): plan/bottom view left (~x132-540), isometric right (~x541-1150).
      pageCrop: { x: 120, y: 270, w: 1050, h: 615 },
      views: {
        front: { x: 136, y: 5,   w: 301, h: 174 },
        side:  { x: 616, y: 5,   w: 414, h: 174 },
        top:   { x: 12,  y: 293, w: 408, h: 285 },
      },
    },
  },
  {
    slug: 'void-air-vantage',
    label: 'VOID Air Vantage',
    url: 'https://d181c7pevbxova.cloudfront.net/media/support-materials/pdfs/Void%20Technical%20Public/User%20guides%20V2/UG10527-2.0%20-%20Air%20Vantage%20User%20Guide.pdf',
    pdfFilename: 'VOID-Air-Vantage-User-Guide.pdf',
    dimensions: {
      page: 8,
      // Page 8: 4-view grid. Top row: front left (x231-488), side right (x665-1150), gap x488-665.
      // Bottom row: plan/top left (x231-527), isometric right (x678-1150), gap x527-678.
      // pageCrop strips VOID header (y0-278) and blank lower half (y926+).
      pageCrop: { x: 225, y: 278, w: 940, h: 648 },
      views: {
        front: { x: 6,   y: 5,   w: 257, h: 193 },
        side:  { x: 440, y: 5,   w: 485, h: 193 },
        top:   { x: 6,   y: 368, w: 296, h: 274 },
      },
    },
  },
  {
    slug: 'void-airten-v3',
    label: 'VOID Airten V3',
    url: 'https://d181c7pevbxova.cloudfront.net/media/support-materials/pdfs/Void%20Technical%20Public/Specification%20Sheets/Air%20Series/Air_Vantage_Specification_Sheet.pdf',
    pdfFilename: 'VOID-Airten-V3-Spec-Sheet.pdf',
    // dimensions: undefined — WRONG PDF. This URL points to the Air Vantage spec sheet,
    // not the Airten V3. No line drawings present. Source the correct Airten V3 PDF first.
  },
  {
    slug: 'bias-v3-amp',
    label: 'Powersoft Bias V3 (amp)',
    url: 'https://d181c7pevbxova.cloudfront.net/media/support-materials/Legacy/Bias%20V3/Bias_V3_V9_user_manual.pdf',
    pdfFilename: 'Bias-V3-V9-User-Manual.pdf',
    dimensions: {
      page: 8,
      // Page 8 (1750×1459px, landscape): Section 4 "Mechanical drawings", Figure 2 = V3.
      // No pageCrop — the entire page is the technical drawing (no VOID brand header).
      // Front panel strip: y0-182. Side profile: y254-1454 (separated by gap y182-253).
      // Col gap at x1463-1473 within side zone separates chassis from rack-ear detail.
      views: {
        front: { x: 55, y: 0,   w: 1457, h: 182  },
        side:  { x: 55, y: 254, w: 1408, h: 1200 },
      },
    },
  },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Render a single PDF page to a PNG buffer using pdfjs-dist + @napi-rs/canvas.
 * scale=2 produces 144 DPI — crisp for both product photos and line drawings.
 */
export async function renderPdfPage(
  pdfBytes: ArrayBuffer,
  pageNum = 1,
  scale = 2,
): Promise<Buffer> {
  const pdfjs = await getPdfjs();
  const { createCanvas } = await import('@napi-rs/canvas');

  // Custom canvas factory: pdfjs calls factory.destroy() after rendering, which normally
  // sets canvas.width = 0 — an operation @napi-rs/canvas rejects with an uncatchable NAPI crash.
  // Overriding destroy() to null the refs (not resize) bypasses the crash entirely.
  let capturedCanvas: any = null;
  const canvasFactory = {
    create(width: number, height: number) {
      capturedCanvas = createCanvas(Math.ceil(width), Math.ceil(height));
      const ctx = capturedCanvas.getContext('2d') as any;
      // Pre-fill white — @napi-rs/canvas starts transparent/black; PDF rendering assumes white page.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, Math.ceil(width), Math.ceil(height));
      return { canvas: capturedCanvas as any, context: ctx };
    },
    reset(canvasAndContext: any, _w: number, _h: number) {
      canvasAndContext.context = canvasAndContext.canvas.getContext('2d');
    },
    destroy(canvasAndContext: any) {
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), canvasFactory } as any).promise;
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const { context: ctx } = canvasFactory.create(viewport.width, viewport.height);
  // intent:'print' skips screen-only PDF layers (e.g. VOID's dark brand gradient backgrounds)
  // leaving only the actual line art on the pre-filled white canvas.
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, intent: 'print' } as any).promise;

  return (capturedCanvas as any).toBuffer('image/png') as Buffer;
}

/**
 * Knock out near-white pixels by setting their alpha to 0.
 * Operates directly on raw RGBA bytes — threshold=240 preserves product graphics
 * and line-drawing ink while removing white page backgrounds.
 */
export async function removeWhiteBackground(
  pngBuffer: Buffer,
  threshold = 240,
): Promise<Buffer> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > threshold && pixels[i + 1] > threshold && pixels[i + 2] > threshold) {
      pixels[i + 3] = 0;
    }
  }

  return sharp(Buffer.from(pixels), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Remove the page background, adapting to whether the PDF rendered with a light
 * or dark background.
 *
 * Light-background PDFs (e.g. Powersoft): remove near-white pixels (R,G,B > 240).
 *
 * Dark-background PDFs (e.g. VOID): the rendered image has near-zero contrast —
 * the background is very dark (~R 14-26) and the line art is only slightly lighter
 * (~R 40-46), so a simple threshold can't separate them. Instead:
 *   1. normalise()  — stretch the histogram to use the full 0-255 range, so
 *                     the lightest pixels (line art, ~R 46) → R 255 (white),
 *                     the darkest pixels (BG, ~R 14)       → R 0   (black).
 *   2. negate()     — invert: line art becomes black (0), background becomes white (255).
 *   3. threshold    — remove near-white pixels (background) using standard 240 cutoff.
 * Result: black line art on a transparent background regardless of original BG colour.
 */
export async function removePageBackground(pngBuffer: Buffer): Promise<Buffer> {
  // Detect background brightness from corner samples
  const { data: rawData, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, stride = w * 4;
  const cornerSamples: Array<[number, number]> = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
  ];
  let bgSum = 0;
  for (const [x, y] of cornerSamples) {
    const i = y * stride + x * 4;
    bgSum += (rawData[i] + rawData[i + 1] + rawData[i + 2]) / 3;
  }
  const bgBrightness = bgSum / cornerSamples.length;
  const isDarkBackground = bgBrightness < 128;

  if (isDarkBackground) {
    // Dark-background pipeline: normalise → negate → remove near-white
    const boosted = await sharp(pngBuffer)
      .normalise()              // stretch min-max to 0-255: dim line art → white, dark BG → black
      .negate({ alpha: false }) // invert RGB only — alpha must stay opaque (255→255 not 255→0)
      .toBuffer();

    const { data, info: bInfo } = await sharp(boosted)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) {
        pixels[i + 3] = 0;
      }
    }
    return sharp(Buffer.from(pixels), {
      raw: { width: bInfo.width, height: bInfo.height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } else {
    // Light-background pipeline: simple near-white removal (threshold 240)
    const pixels = new Uint8Array(rawData);
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) {
        pixels[i + 3] = 0;
      }
    }
    return sharp(Buffer.from(pixels), {
      raw: { width: w, height: h, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
}

/** Sample the 4 corner pixels and return average brightness (0–255). */
async function getCornerBrightness(pngBuffer: Buffer): Promise<number> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, stride = w * 4;
  const corners: Array<[number, number]> = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let sum = 0;
  for (const [x, y] of corners) {
    const i = y * stride + x * 4;
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return sum / corners.length;
}

/** Crop a PNG buffer to the given bounding box using sharp. */
export async function cropImage(pngBuffer: Buffer, bbox: ViewBBox): Promise<Buffer> {
  return sharp(pngBuffer)
    .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Fetch PDF bytes — from local file if it already exists in pdfDir, otherwise download.
 * Saves to pdfDir when downloading and pdfDir is provided.
 */
async function fetchPdfBytes(
  spec: SpeakerPdf,
  pdfDir: string | null,
  log: (msg: string) => void,
): Promise<{ bytes: ArrayBuffer; pdfPath: string | null }> {
  const localPath = pdfDir ? path.join(pdfDir, spec.pdfFilename) : null;

  if (localPath && fs.existsSync(localPath)) {
    log(`  using cached PDF → ${spec.pdfFilename}`);
    const buf = fs.readFileSync(localPath);
    return { bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), pdfPath: localPath };
  }

  log(`  fetching ${spec.pdfFilename}…`);
  const response = await fetch(spec.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${spec.url}`);
  const bytes = await response.arrayBuffer();

  let pdfPath: string | null = null;
  if (pdfDir) {
    pdfPath = path.join(pdfDir, spec.pdfFilename);
    fs.writeFileSync(pdfPath, Buffer.from(bytes));
    log(`  saved PDF → ${spec.pdfFilename}`);
  }

  return { bytes, pdfPath };
}

/**
 * Full extraction pipeline for one speaker.
 *
 * mode='cover' — render page 1, remove background, save as <slug>-cover.png
 * mode='dims'  — render the dimensional drawing page, optional pageCrop, remove background,
 *                save as <slug>-dims.png; if views are configured, also save
 *                <slug>-front.png / -side.png / -top.png
 * mode='both'  — cover + dims
 */
export async function extractSpeakerImage(
  spec: SpeakerPdf,
  outputDir: string,
  pdfDir: string | null,
  mode: ExtractionMode,
  onProgress?: (msg: string) => void,
): Promise<ExtractionResult> {
  const log = onProgress ?? (() => {});
  const result: ExtractionResult = { coverPath: null, dimsPath: null, viewPaths: {}, pdfPath: null };

  const { bytes: pdfBytes, pdfPath } = await fetchPdfBytes(spec, pdfDir, log);
  result.pdfPath = pdfPath;

  // ── Cover ──────────────────────────────────────────────────────────────────
  if (mode === 'cover' || mode === 'both') {
    log(`  rendering cover (page 1)…`);
    const raw = await renderPdfPage(pdfBytes, 1);
    const transparent = await removeWhiteBackground(raw);
    const outPath = path.join(outputDir, `${spec.slug}-cover.png`);
    fs.writeFileSync(outPath, transparent);
    result.coverPath = outPath;
    log(`  saved ${path.basename(outPath)}`);
  }

  // ── Dimensional line drawing ───────────────────────────────────────────────
  if ((mode === 'dims' || mode === 'both') && spec.dimensions) {
    const { page, pageCrop, views } = spec.dimensions;

    log(`  rendering dims (page ${page})…`);
    let raw = await renderPdfPage(pdfBytes, page);

    // VOID PDFs: pdfjs renders only the dark gradient background layer — vector line art paths
    // are silently skipped. Detect this via corner brightness: if near-black, retry with pdftoppm
    // which uses a native Poppler renderer and correctly rasterises all vector content.
    const brightness = await getCornerBrightness(raw);
    if (brightness < 128 && result.pdfPath) {
      log(`  pdfjs rendered dark (brightness=${brightness.toFixed(0)}) — retrying with pdftoppm…`);
      try {
        raw = await renderPdfPageWithPoppler(result.pdfPath, page);
        log(`  pdftoppm render complete`);
      } catch (err) {
        log(`  ⚠  pdftoppm failed (${(err as Error).message}) — keeping pdfjs result`);
      }
    }

    // Apply outer page crop first (isolates specific model when two share a page)
    const cropped = pageCrop ? await cropImage(raw, pageCrop) : raw;
    // Use adaptive background detection — VOID pages are dark-background, Powersoft white-background
    const transparent = await removePageBackground(cropped);

    const dimsPath = path.join(outputDir, `${spec.slug}-dims.png`);
    fs.writeFileSync(dimsPath, transparent);
    result.dimsPath = dimsPath;
    log(`  saved ${path.basename(dimsPath)}`);

    // Per-view crops (only when bboxes have been measured and added to the registry)
    if (views) {
      for (const [viewName, bbox] of Object.entries(views) as Array<['front' | 'side' | 'top', ViewBBox]>) {
        if (!bbox) continue;
        log(`  cropping ${viewName} view…`);
        const viewPng = await cropImage(transparent, bbox);
        const viewPath = path.join(outputDir, `${spec.slug}-${viewName}.png`);
        fs.writeFileSync(viewPath, viewPng);
        result.viewPaths[viewName] = viewPath;
        log(`  saved ${path.basename(viewPath)}`);
      }
    }
  } else if ((mode === 'dims' || mode === 'both') && !spec.dimensions) {
    log(`  ⚠  no dimensions config — skipping dims extraction`);
  }

  return result;
}
