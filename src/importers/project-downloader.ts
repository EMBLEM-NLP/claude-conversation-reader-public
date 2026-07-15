/**
 * @file project-downloader.ts
 * @description Scaffold a local git project from a Claude.ai project — download files
 *              and artifacts, organise by conversation date/UUID, write manifest.json
 * @version 1.1.0
 * @created 2026-04-26T19:00:00Z
 * @lastUpdated 2026-04-26T20:57:21Z
 */
import fs from 'fs';
import path from 'path';
import type { ClaudeApiClient, ClaudeFile, ConversationTree } from '../types.js';
import { conversationUrl, projectUrl } from '../utils/links.js';

/** Convert a WebP buffer to JPEG using sharp. Returns JPEG buffer + 'jpg' ext. */
export async function convertWebpToJpeg(webpBuffer: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(webpBuffer).jpeg({ quality: 90 }).toBuffer();
}

// ── Types ────────────────────────────────────────────────────

export interface ProjectFileEntry {
  uuid: string;
  name: string;
  kind: 'image' | 'document' | 'blob' | 'artifact';
  sender: 'human' | 'assistant';
  category: 'sources' | 'photos' | 'generated' | 'artifacts';
  savedAs: string | null;
  downloaded: boolean;
  localPath: string | null;
}

export interface ConversationArtifact {
  id: string;
  title: string;
  contentType: string;
  content: string;
}

export interface ConversationEntry {
  uuid: string;
  name: string;
  date: string;                 // YYYY-MM-DD from created_at
  folder: string;               // e.g. 2026-02-21_81ef8190_nomad-amp-rack-cable-id
  claudeUrl: string;
  files: ProjectFileEntry[];
}

export interface ProjectManifest {
  project: string;
  project_uuid: string;
  claude_project_url: string;
  generated_at: string;
  total_files: number;
  downloaded: number;
  not_downloadable: number;
  conversations: ConversationEntry[];
}

// ── Helpers ──────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function categorize(fileName: string, sender: 'human' | 'assistant'): 'sources' | 'photos' | 'generated' {
  if (sender === 'assistant') return 'generated';
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'xlsx', 'csv', 'json', 'xml'].includes(ext)) return 'sources';
  return 'photos';
}

function dateFromIso(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

/**
 * Build a semantic photo filename: {conv-descriptor}-{YYYY-MM-DD}-{seq:03d}.{ext}
 * seqMap is mutated — maps `${convSlug}-${date}` → current counter.
 */
function renamePhoto(
  file: ClaudeFile,
  convDescriptor: string,
  savedExt: string,
  seqMap: Map<string, number>,
): string {
  const date = dateFromIso(file.created_at);
  const key = `${convDescriptor}-${date}`;
  const seq = (seqMap.get(key) ?? 0) + 1;
  seqMap.set(key, seq);
  const seqStr = String(seq).padStart(3, '0');
  return `${convDescriptor}-${date}-${seqStr}.${savedExt}`;
}

/**
 * Determine which version subfolder an AI-generated diagram belongs in.
 * Detects explicit version prefixes; everything else goes to v05-latest/.
 */
function versionFolder(fileName: string): string {
  const name = fileName.toLowerCase();
  if (/^page_/.test(name)) return 'v01';
  if (/^v2_/.test(name)) return 'v02';
  if (/^v3_/.test(name)) return 'v03';
  if (/^v4_/.test(name)) return 'v04';
  return 'v05-latest';
}

/** Strip the leading version prefix from AI-generated filenames. */
function stripVersionPrefix(fileName: string): string {
  return fileName.replace(/^v\d+_/i, '');
}

/** Derive a short conversation descriptor from its name (first 3 significant words). */
function convDescriptor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-');
}

/** Extract ClaudeFile objects from all messages in a conversation tree. */
export function extractFiles(
  tree: ConversationTree,
): Array<{ file: ClaudeFile; sender: 'human' | 'assistant' }> {
  const results: Array<{ file: ClaudeFile; sender: 'human' | 'assistant' }> = [];
  const seen = new Set<string>();

  for (const msg of (tree as any).chat_messages ?? []) {
    const sender: 'human' | 'assistant' = msg.sender === 'human' ? 'human' : 'assistant';
    for (const f of (msg.files ?? []) as ClaudeFile[]) {
      if (!f.file_uuid || seen.has(f.file_uuid)) continue;
      seen.add(f.file_uuid);
      results.push({ file: f, sender });
    }
  }
  return results;
}

const MIME_EXT: Record<string, string> = {
  'text/markdown': 'md',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'text/javascript': 'js',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/x-python': 'py',
  'text/x-typescript': 'ts',
  'text/css': 'css',
  'text/csv': 'csv',
};

/** Extract artifact tool_use blocks (command=create) from a conversation tree. */
export function extractArtifacts(tree: ConversationTree): ConversationArtifact[] {
  const results: ConversationArtifact[] = [];
  for (const msg of (tree as any).chat_messages ?? []) {
    for (const block of (msg.content ?? []) as any[]) {
      if (
        block.type === 'tool_use' &&
        block.name === 'artifacts' &&
        block.input?.command === 'create' &&
        block.input?.content
      ) {
        results.push({
          id: block.id ?? block.input?.id ?? '',
          title: block.input.title ?? 'Untitled',
          contentType: block.input.type ?? 'text/plain',
          content: block.input.content,
        });
      }
    }
  }
  return results;
}

// ── Scaffold / Download ───────────────────────────────────────

export interface ScaffoldOptions {
  outputDir: string;
  projectName: string;
  projectUuid: string;
  conversations: Array<{ tree: ConversationTree; uuid: string; name: string }>;
  client: ClaudeApiClient;
  download: boolean;
  convertImages?: boolean;
  onProgress?: (msg: string) => void;
}

export async function scaffoldProject(opts: ScaffoldOptions): Promise<ProjectManifest> {
  const { outputDir, projectName, projectUuid, conversations, client, download, convertImages, onProgress } = opts;
  const log = onProgress ?? (() => {});

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '.gitignore'), '# All files tracked — including binaries\n');

  const convEntries: ConversationEntry[] = [];
  let totalFiles = 0;
  let downloaded = 0;
  let notDownloadable = 0;

  for (const { tree, uuid, name } of conversations) {
    const date = dateFromIso((tree as any).created_at ?? new Date().toISOString());
    const folder = `${date}_${uuid.slice(0, 8)}_${slugify(name)}`;
    const convDir = path.join(outputDir, folder);
    const descriptor = convDescriptor(name);
    const photoSeqMap = new Map<string, number>(); // tracks photo sequence per date

    // Wipe the generated/ dir on each run so stale versioned subfolders don't accumulate
    const generatedDir = path.join(convDir, 'generated');
    if (fs.existsSync(generatedDir)) fs.rmSync(generatedDir, { recursive: true, force: true });

    const rawFiles = extractFiles(tree);
    const fileEntries: ProjectFileEntry[] = [];

    for (const { file, sender } of rawFiles) {
      const category = categorize(file.file_name, sender);

      // Determine the actual subfolder:
      // - photos → photos/ (renamed)
      // - generated → generated/v01/ … v05-latest/ (versioned)
      // - sources → sources/
      let subDir: string;
      if (category === 'generated') {
        const ver = versionFolder(file.file_name);
        subDir = path.join(convDir, 'generated', ver);
      } else {
        subDir = path.join(convDir, category);
      }
      fs.mkdirSync(subDir, { recursive: true });

      let savedAs: string | null = null;
      let didDownload = false;

      if (download) {
        log(`  ↓ ${file.file_name}`);
        try {
          const result = await client.downloadFile(file);
          if (result) {
            let buf = result.buffer;
            let ext = result.ext;

            // Optionally convert WebP images → JPEG
            if (convertImages && ext === 'webp') {
              buf = await convertWebpToJpeg(buf);
              ext = 'jpg';
            }

            // Apply naming conventions
            if (category === 'photos') {
              savedAs = renamePhoto(file, descriptor, ext, photoSeqMap);
            } else if (category === 'generated') {
              // Strip version prefix from generated filenames (it's now in the folder)
              const stripped = stripVersionPrefix(file.file_name).replace(/\.[^.]+$/, '');
              savedAs = `${stripped}.${ext}`;
            } else {
              const base = file.file_name.replace(/\.[^.]+$/, '');
              savedAs = `${base}.${ext}`;
            }

            const dest = path.join(subDir, savedAs);
            fs.writeFileSync(dest, buf);
            // Remove stale alternate-extension file
            const altExt = ext === 'jpg' ? 'webp' : ext === 'webp' ? 'jpg' : null;
            if (altExt) {
              const altPath = path.join(subDir, savedAs.replace(/\.[^.]+$/, `.${altExt}`));
              if (fs.existsSync(altPath)) fs.unlinkSync(altPath);
            }
            didDownload = true;
            downloaded++;
          } else {
            // Not downloadable (blob/DOCX) — create a placeholder
            savedAs = `${file.file_name}.NOT_DOWNLOADABLE.txt`;
            fs.writeFileSync(
              path.join(subDir, savedAs),
              `File: ${file.file_name}\nUUID: ${file.file_uuid}\nKind: ${file.file_kind}\n` +
                `Reason: Claude.ai does not expose a download endpoint for '${file.file_kind}' files.\n`,
            );
            notDownloadable++;
          }
        } catch (err) {
          log(`  ✗ ${file.file_name}: ${(err as Error).message}`);
          notDownloadable++;
        }
      } else {
        // Scaffold only — create dirs
        fs.mkdirSync(subDir, { recursive: true });
        savedAs = null;
      }

      totalFiles++;
      const relCategory = category === 'generated'
        ? path.join('generated', versionFolder(file.file_name))
        : category;
      fileEntries.push({
        uuid: file.file_uuid,
        name: file.file_name,
        kind: file.file_kind,
        sender,
        category,
        savedAs,
        downloaded: didDownload,
        localPath: savedAs ? path.join(folder, relCategory, savedAs) : null,
      });
    }

    // Extract and save artifacts (tool_use blocks with name=artifacts)
    const artifacts = extractArtifacts(tree);
    if (artifacts.length) {
      const artifactDir = path.join(convDir, 'artifacts');
      fs.mkdirSync(artifactDir, { recursive: true });
      for (const art of artifacts) {
        const ext = MIME_EXT[art.contentType] ?? 'txt';
        const slug = art.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60);
        const fileName = `${slug}.${ext}`;
        fs.writeFileSync(path.join(artifactDir, fileName), art.content, 'utf-8');
        totalFiles++;
        downloaded++;
        fileEntries.push({
          uuid: art.id,
          name: art.title,
          kind: 'artifact',
          sender: 'assistant',
          category: 'artifacts',
          savedAs: fileName,
          downloaded: true,
          localPath: path.join(folder, 'artifacts', fileName),
        });
      }
    }

    // Write per-conversation MANIFEST.md
    writeConvManifest(convDir, { uuid, name, date, folder, claudeUrl: conversationUrl(uuid), files: fileEntries });
    convEntries.push({ uuid, name, date, folder, claudeUrl: conversationUrl(uuid), files: fileEntries });
  }

  const manifest: ProjectManifest = {
    project: projectName,
    project_uuid: projectUuid,
    claude_project_url: projectUrl(projectUuid),
    generated_at: new Date().toISOString(),
    total_files: totalFiles,
    downloaded,
    not_downloadable: notDownloadable,
    conversations: convEntries,
  };

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeRootReadme(outputDir, manifest);

  return manifest;
}

// ── Writers ───────────────────────────────────────────────────

function writeConvManifest(convDir: string, conv: ConversationEntry): void {
  fs.mkdirSync(convDir, { recursive: true });
  const humanFiles = conv.files.filter((f) => f.sender === 'human' && f.category !== 'artifacts');
  const asstFiles = conv.files.filter((f) => f.sender === 'assistant' && f.category === 'generated');
  const artifactFiles = conv.files.filter((f) => f.category === 'artifacts');

  const lines: string[] = [
    `# ${conv.name}`,
    '',
    `**Date:** ${conv.date}  `,
    `**UUID:** \`${conv.uuid}\`  `,
    `**Claude.ai:** ${conv.claudeUrl}`,
    '',
  ];

  if (humanFiles.length) {
    lines.push(`## Uploaded files (${humanFiles.length})`);
    lines.push('');
    lines.push('| Category | Original name | Saved as | Downloadable |');
    lines.push('|---|---|---|---|');
    for (const f of humanFiles) {
      const saved = f.savedAs ?? '—';
      const dl = f.downloaded ? '✓' : f.kind === 'blob' ? '✗ (blob)' : '—';
      lines.push(`| ${f.category} | \`${f.name}\` | \`${saved}\` | ${dl} |`);
    }
    lines.push('');
  }

  if (artifactFiles.length) {
    lines.push(`## Artifacts (${artifactFiles.length})`);
    lines.push('');
    lines.push('| Title | File | Size |');
    lines.push('|---|---|---|');
    for (const f of artifactFiles) {
      const size = f.savedAs ? `${(f.localPath?.length ?? 0)} chars` : '—';
      lines.push(`| ${f.name} | \`${f.savedAs ?? '—'}\` | — |`);
    }
    lines.push('');
  }

  if (asstFiles.length) {
    lines.push(`## Generated files (${asstFiles.length})`);
    lines.push('');
    for (const f of asstFiles) {
      lines.push(`- \`${f.savedAs ?? f.name}\``);
    }
    lines.push('');
  }

  if (!conv.files.length) {
    lines.push('_No files in this conversation (text only)._');
  }

  fs.writeFileSync(path.join(convDir, 'MANIFEST.md'), lines.join('\n'));
}

function writeRootReadme(outputDir: string, manifest: ProjectManifest): void {
  const lines: string[] = [
    `# ${manifest.project}`,
    '',
    `**Claude.ai project:** [${manifest.project_uuid.slice(0, 8)}](${manifest.claude_project_url})  `,
    `**Generated:** ${manifest.generated_at.slice(0, 10)}  `,
    `**Files:** ${manifest.downloaded} downloaded, ${manifest.not_downloadable} not downloadable`,
    '',
    '## Conversations',
    '',
    '| Date | Conversation | Files |',
    '|---|---|---|',
  ];

  for (const conv of manifest.conversations) {
    const count = conv.files.length;
    lines.push(`| ${conv.date} | [${conv.name}](${conv.claudeUrl}) | ${count} |`);
  }

  lines.push('', '## Notes', '');
  lines.push('- Images downloaded as **WebP** (Claude.ai serves previews in WebP format)');
  lines.push('- PDFs downloaded from `document_pdf` variant — original bytes');
  lines.push('- DOCX/blob files: not accessible via Claude.ai API — `.NOT_DOWNLOADABLE.txt` placeholder written');
  lines.push('- Re-run `download-project-files` after source docs are re-uploaded to recover blobs');
  lines.push('');

  fs.writeFileSync(path.join(outputDir, 'README.md'), lines.join('\n'));
}
